import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import handleIntake, { parseNotificationMessage, type WorkQueue } from "./handler.js";

describe("parseNotificationMessage", () => {
  it("parses single assigned notification", () => {
    const result = parseNotificationMessage("Assigned to issue ENG-42: Fix login bug");
    expect(result).toEqual([
      { id: "ENG-42", event: "issue.assigned", summary: "Fix login bug" },
    ]);
  });

  it("parses multi-notification message", () => {
    const msg = `You have 3 new Linear notifications:

1. [Assigned] ENG-42: Fix login bug
2. [Mentioned] ENG-43: "Can you review this?"
3. [Reassigned] ENG-44: Update API docs

Review and prioritize before starting work.`;

    const result = parseNotificationMessage(msg);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ id: "ENG-42", event: "issue.assigned", summary: "Fix login bug" });
    expect(result[1]).toEqual({ id: "ENG-43", event: "comment.mention", summary: "Can you review this?" });
    expect(result[2]).toEqual({ id: "ENG-44", event: "issue.reassigned", summary: "Update API docs" });
  });
});

describe("handleIntake", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "queue-test-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("creates queue file and adds 3 items from multi-notification", () => {
    const msg = `You have 3 new Linear notifications:

1. [Assigned] ENG-42: Fix login bug
2. [Mentioned] ENG-43: Review PR
3. [Reassigned] ENG-44: Update docs

Review and prioritize before starting work.`;

    const added = handleIntake(msg, workDir);
    expect(added).toBe(3);

    const queue: WorkQueue = JSON.parse(
      readFileSync(join(workDir, "queue", "work-queue.json"), "utf-8"),
    );
    expect(queue.items).toHaveLength(3);
    // Sorted by priority: assigned (1) < reassigned (2) < mentioned (3)
    expect(queue.items[0].id).toBe("ENG-42");
    expect(queue.items[0].priority).toBe(1);
    expect(queue.items[1].id).toBe("ENG-44");
    expect(queue.items[1].priority).toBe(2);
    expect(queue.items[2].id).toBe("ENG-43");
    expect(queue.items[2].priority).toBe(3);
  });

  it("deduplicates same issue + event across batches", () => {
    const msg1 = "Assigned to issue ENG-42: Fix login bug";
    const msg2 = "Assigned to issue ENG-42: Fix login bug";

    handleIntake(msg1, workDir);
    const added = handleIntake(msg2, workDir);

    expect(added).toBe(0);

    const queue: WorkQueue = JSON.parse(
      readFileSync(join(workDir, "queue", "work-queue.json"), "utf-8"),
    );
    expect(queue.items).toHaveLength(1);
  });

  it("adds only new items when mix of new and existing", () => {
    // First batch
    handleIntake("Assigned to issue ENG-42: Fix login bug", workDir);

    // Second batch with mix
    const msg = `You have 2 new Linear notifications:

1. [Assigned] ENG-42: Fix login bug
2. [Assigned] ENG-50: New feature

Review and prioritize before starting work.`;

    const added = handleIntake(msg, workDir);
    expect(added).toBe(1);

    const queue: WorkQueue = JSON.parse(
      readFileSync(join(workDir, "queue", "work-queue.json"), "utf-8"),
    );
    expect(queue.items).toHaveLength(2);
  });

  it("creates queue directory and file when they don't exist", () => {
    const added = handleIntake("Assigned to issue ENG-42: Fix login bug", workDir);
    expect(added).toBe(1);

    const queue: WorkQueue = JSON.parse(
      readFileSync(join(workDir, "queue", "work-queue.json"), "utf-8"),
    );
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0].status).toBe("pending");
    expect(queue.items[0].startedAt).toBeNull();
    expect(queue.items[0].completedAt).toBeNull();
  });
});
