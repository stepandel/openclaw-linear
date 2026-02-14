import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import handleRecovery, { type WorkQueue } from "./handler.js";

function writeQueue(workDir: string, queue: WorkQueue): void {
  const dir = join(workDir, "queue");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "work-queue.json"), JSON.stringify(queue, null, 2), "utf-8");
}

function readQueue(workDir: string): WorkQueue {
  return JSON.parse(readFileSync(join(workDir, "queue", "work-queue.json"), "utf-8"));
}

const makeItem = (overrides: Partial<import("./handler.js").QueueItem> = {}): import("./handler.js").QueueItem => ({
  id: "ENG-1",
  issueId: "uuid-1",
  event: "issue.assigned",
  summary: "Test item",
  status: "pending",
  priority: 1,
  addedAt: "2026-02-14T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
  ...overrides,
});

describe("handleRecovery", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "recovery-test-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("resets in_progress items to pending", () => {
    writeQueue(workDir, {
      items: [
        makeItem({ id: "ENG-1", status: "in_progress", startedAt: "2026-02-14T10:00:00.000Z" }),
        makeItem({ id: "ENG-2", status: "pending" }),
        makeItem({ id: "ENG-3", status: "pending" }),
      ],
    });

    const recovered = handleRecovery(workDir);
    expect(recovered).toBe(1);

    const queue = readQueue(workDir);
    expect(queue.items[0].status).toBe("pending");
    expect(queue.items[0].startedAt).toBeNull();
    expect(queue.items[1].status).toBe("pending");
    expect(queue.items[2].status).toBe("pending");
  });

  it("does nothing when all items are done", () => {
    writeQueue(workDir, {
      items: [
        makeItem({ id: "ENG-1", status: "done", completedAt: "2026-02-14T12:00:00.000Z" }),
        makeItem({ id: "ENG-2", status: "done", completedAt: "2026-02-14T12:00:00.000Z" }),
      ],
    });

    const recovered = handleRecovery(workDir);
    expect(recovered).toBe(0);
  });

  it("no-ops when queue file does not exist", () => {
    const recovered = handleRecovery(workDir);
    expect(recovered).toBe(0);
  });

  it("no-ops when items array is empty", () => {
    writeQueue(workDir, { items: [] });

    const recovered = handleRecovery(workDir);
    expect(recovered).toBe(0);
  });
});
