import { readFileSync, writeFileSync, existsSync, renameSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";

export interface QueueItem {
  id: string;
  issueId: string;
  event: string;
  summary: string;
  status: "pending" | "in_progress" | "done";
  priority: number;
  addedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkQueue {
  items: QueueItem[];
}

/**
 * Reset stale in_progress queue items to pending on gateway startup.
 * Returns the number of items recovered.
 */
export default function handleRecovery(workspaceDir: string): number {
  const queuePath = join(workspaceDir, "queue", "work-queue.json");

  if (!existsSync(queuePath)) {
    return 0;
  }

  let queue: WorkQueue;
  try {
    const data = readFileSync(queuePath, "utf-8");
    queue = JSON.parse(data) as WorkQueue;
  } catch {
    return 0;
  }

  if (!Array.isArray(queue.items) || queue.items.length === 0) {
    return 0;
  }

  let recovered = 0;

  for (const item of queue.items) {
    if (item.status === "in_progress") {
      console.log(`[linear-queue-recovery] Resetting stale item ${item.id} (${item.summary}) to pending`);
      item.status = "pending";
      item.startedAt = null;
      recovered++;
    }
  }

  if (recovered > 0) {
    const content = JSON.stringify(queue, null, 2) + "\n";
    const tmpPath = `${queuePath}.tmp.${process.pid}.${Date.now()}`;
    try {
      const fd = openSync(tmpPath, "w");
      try {
        writeSync(fd, content, 0, "utf-8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmpPath, queuePath);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
      throw err;
    }
    console.log(`[linear-queue-recovery] Recovered ${recovered} stale item(s)`);
  }

  return recovered;
}
