import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  InboxQueue,
  QUEUE_EVENT,
  type QueueItem,
  type EnqueueEntry,
} from "../src/work-queue.js";

const TMP_DIR = join(import.meta.dirname ?? __dirname, "../.test-tmp");
const QUEUE_PATH = join(TMP_DIR, "queue", "inbox.jsonl");

function readItems(): QueueItem[] {
  try {
    const content = readFileSync(QUEUE_PATH, "utf-8");
    return content
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as QueueItem);
  } catch {
    return [];
  }
}

function entry(
  id: string,
  event: string,
  summary: string,
  issuePriority = 0,
  workspaceId?: string,
): EnqueueEntry {
  const e: EnqueueEntry = { id, event, summary, issuePriority };
  if (workspaceId) e.workspaceId = workspaceId;
  return e;
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// --- InboxQueue.enqueue ---

describe("InboxQueue.enqueue", () => {
  it("adds items to empty queue with issue priority", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const added = await queue.enqueue([
      entry("ENG-42", "issue.assigned", "Fix login bug", 1),
    ]);
    expect(added).toBe(1);
    const items = readItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "ENG-42",
      event: "ticket",
      summary: "Fix login bug",
      priority: 1,
    });
  });

  it("maps no-priority (0) to sort last", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-1", "issue.assigned", "No priority task", 0),
      entry("ENG-2", "issue.assigned", "Low priority task", 4),
    ]);
    const items = await queue.peek();
    expect(items[0].id).toBe("ENG-2");
    expect(items[0].priority).toBe(4);
    expect(items[1].id).toBe("ENG-1");
    expect(items[1].priority).toBe(5);
  });

  it("deduplicates against existing items", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);
    const added = await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);
    expect(added).toBe(0);
    expect(readItems()).toHaveLength(1);
  });

  it("allows same issue with different queue events", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);
    const added = await queue.enqueue([entry("ENG-42", "comment.mention", "Fix login bug", 2)]);
    expect(added).toBe(1);
    const items = readItems();
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.event)).toEqual(["ticket", "mention"]);
  });

  it("deduplicates within the same batch", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const added = await queue.enqueue([
      entry("ENG-42", "issue.assigned", "Fix login bug", 2),
      entry("ENG-42", "issue.assigned", "Fix login bug", 2),
    ]);
    expect(added).toBe(1);
  });

  it("returns 0 for empty entries", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    expect(await queue.enqueue([])).toBe(0);
  });

  it("uses issue priority for queue ordering", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-10", "issue.assigned", "low fix", 4),
      entry("ENG-11", "issue.assigned", "urgent fix", 1),
    ]);
    const items = await queue.peek();
    expect(items.map((i) => i.id)).toEqual(["ENG-11", "ENG-10"]);
    expect(items.map((i) => i.priority)).toEqual([1, 4]);
  });

  it("always prioritizes mentions over tickets", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-11", "issue.assigned", "urgent fix", 1),
      entry("ENG-10", "comment.mention", "hey", 4),
    ]);
    const items = await queue.peek();
    expect(items[0].event).toBe("mention");
    expect(items[0].priority).toBe(0);
    expect(items[1].event).toBe("ticket");
    expect(items[1].priority).toBe(1);
  });

  it("does not dedup different comments on the same issue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      { id: "comment-1", issueId: "ENG-42", event: "comment.mention", summary: "first mention", issuePriority: 2 },
    ]);
    const added = await queue.enqueue([
      { id: "comment-2", issueId: "ENG-42", event: "comment.mention", summary: "second mention", issuePriority: 2 },
    ]);
    expect(added).toBe(1);
    const items = readItems();
    expect(items).toHaveLength(2);
    expect(items[0].issueId).toBe("ENG-42");
    expect(items[1].issueId).toBe("ENG-42");
    expect(items[0].id).toBe("comment-1");
    expect(items[1].id).toBe("comment-2");
  });

  it("uses issueId from entry when provided", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      { id: "comment-abc", issueId: "ENG-10", event: "comment.mention", summary: "hey", issuePriority: 3 },
    ]);
    const items = readItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("comment-abc");
    expect(items[0].issueId).toBe("ENG-10");
  });
});

// --- InboxQueue.pop (claim semantics) ---

describe("InboxQueue.pop", () => {
  it("returns null for empty queue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    expect(await queue.pop()).toBeNull();
  });

  it("marks highest-priority item as in_progress (not removed)", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-10", "comment.mention", "hey", 4),
      entry("ENG-11", "issue.assigned", "urgent fix", 1),
    ]);

    // Mentions always get priority 0, so ENG-10 is popped first
    const item = await queue.pop();
    expect(item!.id).toBe("ENG-10");
    expect(item!.status).toBe("in_progress");

    // Both items still in file, but ENG-10 is in_progress
    const onDisk = readItems();
    expect(onDisk).toHaveLength(2);
    expect(onDisk.find((i) => i.id === "ENG-10")!.status).toBe("in_progress");
    expect(onDisk.find((i) => i.id === "ENG-11")!.status).toBe("pending");
  });

  it("skips in_progress items and returns next pending", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-10", "comment.mention", "hey", 4),
      entry("ENG-11", "issue.assigned", "urgent fix", 1),
    ]);

    const first = await queue.pop();
    expect(first!.id).toBe("ENG-10");

    const second = await queue.pop();
    expect(second!.id).toBe("ENG-11");

    // No more pending items
    expect(await queue.pop()).toBeNull();
  });

  it("returns items in priority order across multiple pops", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-10", "comment.mention", "hey", 4),
      entry("ENG-11", "issue.assigned", "urgent fix", 1),
      entry("ENG-12", "issue.assigned", "medium task", 3),
    ]);

    // Mention (priority 0) first, then tickets by issue priority
    expect((await queue.pop())!.id).toBe("ENG-10");
    expect((await queue.pop())!.id).toBe("ENG-11");
    expect((await queue.pop())!.id).toBe("ENG-12");
    expect(await queue.pop()).toBeNull();
  });
});

// --- InboxQueue.peek ---

describe("InboxQueue.peek", () => {
  it("returns empty array for empty queue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    expect(await queue.peek()).toEqual([]);
  });

  it("returns items sorted by priority", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-10", "comment.mention", "hey", 4),
      entry("ENG-11", "issue.assigned", "urgent fix", 1),
    ]);

    // Mention gets priority 0, always before tickets
    const items = await queue.peek();
    expect(items.map((i) => i.id)).toEqual(["ENG-10", "ENG-11"]);
    expect(items.map((i) => i.priority)).toEqual([0, 1]);
  });

  it("does not remove items", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);
    await queue.peek();
    await queue.peek();
    expect(readItems()).toHaveLength(1);
  });

  it("only returns pending items", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-10", "comment.mention", "hey", 4),
      entry("ENG-11", "issue.assigned", "urgent fix", 1),
    ]);

    // Claim one (mention pops first)
    await queue.pop();

    const items = await queue.peek();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("ENG-11");
    expect(items[0].status).toBe("pending");
  });
});

// --- InboxQueue.drain (claim semantics) ---

describe("InboxQueue.drain", () => {
  it("returns empty array for empty queue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    expect(await queue.drain()).toEqual([]);
  });

  it("claims all pending items sorted by priority", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-10", "comment.mention", "hey", 4),
      entry("ENG-11", "issue.assigned", "urgent fix", 1),
    ]);

    const items = await queue.drain();
    expect(items.map((i) => i.id)).toEqual(["ENG-10", "ENG-11"]);
    expect(items.every((i) => i.status === "in_progress")).toBe(true);

    // Items still on disk but all in_progress
    const onDisk = readItems();
    expect(onDisk).toHaveLength(2);
    expect(onDisk.every((i) => i.status === "in_progress")).toBe(true);

    // No pending items left
    expect(await queue.peek()).toEqual([]);
  });

  it("skips already in_progress items", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-10", "comment.mention", "hey", 4),
      entry("ENG-11", "issue.assigned", "urgent fix", 1),
    ]);

    // Claim one via pop (mention pops first)
    await queue.pop();

    // Drain should only get remaining pending item
    const items = await queue.drain();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("ENG-11");
  });
});

// --- InboxQueue.complete ---

describe("InboxQueue.complete", () => {
  it("removes in_progress item matching issueId", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix bug", 2)]);
    await queue.pop(); // claim it

    const result = await queue.complete("ENG-42");
    expect(result).toBe(true);
    expect(readItems()).toHaveLength(0);
  });

  it("is a no-op for non-existent issueId", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix bug", 2)]);
    await queue.pop();

    const result = await queue.complete("ENG-99");
    expect(result).toBe(false);
    expect(readItems()).toHaveLength(1);
  });

  it("does not remove pending items", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix bug", 2)]);

    // Item is pending, not in_progress
    const result = await queue.complete("ENG-42");
    expect(result).toBe(false);
    expect(readItems()).toHaveLength(1);
  });
});

// --- InboxQueue.recover ---

describe("InboxQueue.recover", () => {
  it("resets in_progress items back to pending", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-10", "comment.mention", "hey", 4),
      entry("ENG-11", "issue.assigned", "urgent fix", 1),
    ]);
    await queue.pop(); // claim ENG-10 (mention)

    const count = await queue.recover();
    expect(count).toBe(1);

    const items = readItems();
    expect(items.every((i) => i.status === "pending")).toBe(true);
  });

  it("returns 0 when no in_progress items", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix bug", 2)]);

    const count = await queue.recover();
    expect(count).toBe(0);
  });

  it("returns 0 for empty queue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const count = await queue.recover();
    expect(count).toBe(0);
  });
});

// --- Backward compatibility ---

describe("InboxQueue backward compatibility", () => {
  it("treats items without status field as pending", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    // Write an item without status field (old format)
    mkdirSync(dirname(QUEUE_PATH), { recursive: true });
    writeFileSync(
      QUEUE_PATH,
      JSON.stringify({ id: "ENG-1", issueId: "ENG-1", event: "ticket", summary: "Old item", priority: 2, addedAt: "2024-01-01T00:00:00.000Z" }) + "\n",
    );

    const items = await queue.peek();
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("pending");

    // Should be claimable via pop
    const claimed = await queue.pop();
    expect(claimed!.id).toBe("ENG-1");
    expect(claimed!.status).toBe("in_progress");
  });
});

// --- Removal events ---

describe("InboxQueue removal events", () => {
  it("removes existing ticket on issue.unassigned", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);
    expect(readItems()).toHaveLength(1);

    const added = await queue.enqueue([entry("ENG-42", "issue.unassigned", "Fix login bug", 2)]);
    expect(added).toBe(0);
    expect(readItems()).toHaveLength(0);
  });

  it("removes existing ticket on issue.reassigned", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);

    const added = await queue.enqueue([entry("ENG-42", "issue.reassigned", "Fix login bug", 2)]);
    expect(added).toBe(0);
    expect(readItems()).toHaveLength(0);
  });

  it("removes existing ticket on issue.removed", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);

    const added = await queue.enqueue([entry("ENG-42", "issue.removed", "Fix login bug", 2)]);
    expect(added).toBe(0);
    expect(readItems()).toHaveLength(0);
  });

  it("removes existing ticket on issue.state_removed", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);

    const added = await queue.enqueue([entry("ENG-42", "issue.state_removed", "Fix login bug", 2)]);
    expect(added).toBe(0);
    expect(readItems()).toHaveLength(0);
  });

  it("is a no-op on empty queue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const added = await queue.enqueue([entry("ENG-42", "issue.unassigned", "Fix login bug", 2)]);
    expect(added).toBe(0);
    expect(readItems()).toHaveLength(0);
  });

  it("does not affect mention items for same issue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "comment.mention", "hey", 2)]);
    expect(readItems()).toHaveLength(1);

    await queue.enqueue([entry("ENG-42", "issue.unassigned", "Fix login bug", 2)]);
    const items = readItems();
    expect(items).toHaveLength(1);
    expect(items[0].event).toBe("mention");
  });

  it("does not affect ticket items for different issues", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-42", "issue.assigned", "Fix login bug", 2),
      entry("ENG-43", "issue.assigned", "Update docs", 3),
    ]);

    await queue.enqueue([entry("ENG-42", "issue.unassigned", "Fix login bug", 2)]);
    const items = readItems();
    expect(items).toHaveLength(1);
    expect(items[0].issueId).toBe("ENG-43");
  });

  it("removes in_progress items on removal event", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);
    await queue.pop(); // claim it (in_progress)

    const onDisk = readItems();
    expect(onDisk[0].status).toBe("in_progress");

    // Unassign should remove even though in_progress
    await queue.enqueue([entry("ENG-42", "issue.unassigned", "Fix login bug", 2)]);
    expect(readItems()).toHaveLength(0);
  });
});

// --- Priority update ---

describe("InboxQueue priority update", () => {
  it("updates priority in-place for matching items", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 3)]);
    expect(readItems()[0].priority).toBe(3);

    const added = await queue.enqueue([entry("ENG-42", "issue.priority_changed", "Fix login bug", 1)]);
    expect(added).toBe(0);
    const items = readItems();
    expect(items).toHaveLength(1);
    expect(items[0].priority).toBe(1);
  });

  it("maps no-priority (0) to 5 on update", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);

    await queue.enqueue([entry("ENG-42", "issue.priority_changed", "Fix login bug", 0)]);
    expect(readItems()[0].priority).toBe(5);
  });

  it("is a no-op when issue is not in queue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);

    await queue.enqueue([entry("ENG-99", "issue.priority_changed", "Other", 1)]);
    const items = readItems();
    expect(items).toHaveLength(1);
    expect(items[0].priority).toBe(2);
  });
});

// --- QUEUE_EVENT mapping ---

describe("QUEUE_EVENT mapping", () => {
  it("maps raw events to queue events", () => {
    expect(QUEUE_EVENT["issue.assigned"]).toBe("ticket");
    expect(QUEUE_EVENT["issue.state_readded"]).toBe("ticket");
    expect(QUEUE_EVENT["comment.mention"]).toBe("mention");
    expect(QUEUE_EVENT["issue.reassigned"]).toBeUndefined();
    expect(QUEUE_EVENT["issue.unassigned"]).toBeUndefined();
  });
});

describe("InboxQueue issue.state_readded enqueue", () => {
  it("enqueues issue.state_readded as a ticket", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const added = await queue.enqueue([
      entry("ENG-42", "issue.state_readded", "Bounced task", 2),
    ]);
    expect(added).toBe(1);
    const items = readItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "ENG-42",
      event: "ticket",
      summary: "Bounced task",
      priority: 2,
    });
  });
});

// --- Mutex serialization ---

describe("InboxQueue mutex serialization", () => {
  it("serializes concurrent enqueue calls", async () => {
    const queue = new InboxQueue(QUEUE_PATH);

    // Fire two enqueues concurrently — both should complete without data loss
    const [a, b] = await Promise.all([
      queue.enqueue([entry("ENG-1", "issue.assigned", "Task one", 2)]),
      queue.enqueue([entry("ENG-2", "issue.assigned", "Task two", 3)]),
    ]);

    expect(a + b).toBe(2);
    const items = readItems();
    expect(items).toHaveLength(2);
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual(["ENG-1", "ENG-2"]);
  });

  it("serializes concurrent pop calls", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-1", "issue.assigned", "Task one", 2)]);
    await queue.enqueue([entry("ENG-2", "issue.assigned", "Task two", 3)]);

    const [a, b] = await Promise.all([queue.pop(), queue.pop()]);
    const results = [a, b].filter(Boolean);
    expect(results).toHaveLength(2);

    // Each item claimed exactly once
    const ids = results.map((r) => r!.id).sort();
    expect(ids).toEqual(["ENG-1", "ENG-2"]);

    // No more pending items
    expect(await queue.pop()).toBeNull();

    // Both items still on disk as in_progress
    const onDisk = readItems();
    expect(onDisk).toHaveLength(2);
    expect(onDisk.every((i) => i.status === "in_progress")).toBe(true);
  });
});

// --- Cross-workspace dedup isolation ---

describe("InboxQueue cross-workspace dedup", () => {
  it("allows same issue ID from different workspaces", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const added1 = await queue.enqueue([
      entry("ENG-42", "issue.assigned", "Fix bug (ws-A)", 2, "ws-A"),
    ]);
    const added2 = await queue.enqueue([
      entry("ENG-42", "issue.assigned", "Fix bug (ws-B)", 2, "ws-B"),
    ]);

    expect(added1).toBe(1);
    expect(added2).toBe(1);

    const items = readItems();
    expect(items).toHaveLength(2);
    expect(items[0].workspaceId).toBe("ws-A");
    expect(items[1].workspaceId).toBe("ws-B");
  });

  it("deduplicates same issue ID within same workspace", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-42", "issue.assigned", "Fix bug", 2, "ws-A"),
    ]);
    const added = await queue.enqueue([
      entry("ENG-42", "issue.assigned", "Fix bug", 2, "ws-A"),
    ]);

    expect(added).toBe(0);
    expect(readItems()).toHaveLength(1);
  });

  it("items without workspaceId use 'default' for dedup", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix bug", 2)]);
    const added = await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix bug", 2)]);

    expect(added).toBe(0);
    expect(readItems()).toHaveLength(1);
  });

  it("workspace items don't collide with default items", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix bug", 2)]);
    const added = await queue.enqueue([
      entry("ENG-42", "issue.assigned", "Fix bug (ws-A)", 2, "ws-A"),
    ]);

    expect(added).toBe(1);
    expect(readItems()).toHaveLength(2);
  });
});
