import {
  readFileSync,
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  unlinkSync,
  renameSync,
  appendFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { safeParseJson } from "openclaw/plugin-sdk/text-runtime";

export interface QueueItem {
  id: string;
  issueId: string;
  event: string;
  summary: string;
  priority: number;
  addedAt: string;
  status: "pending" | "in_progress";
}

export const QUEUE_EVENT: Record<string, string> = {
  "issue.assigned": "ticket",
  "issue.state_readded": "ticket",
  "comment.mention": "mention",
};

const REMOVAL_EVENTS = new Set([
  "issue.unassigned",
  "issue.reassigned",
  "issue.removed",
  "issue.state_removed",
]);

export interface EnqueueEntry {
  id: string;
  /** Issue identifier for queue display and completion. Defaults to `id`. */
  issueId?: string;
  event: string;
  summary: string;
  issuePriority: number;
}

/** Map Linear priority (0=none) so no-priority sorts last. */
function mapPriority(linearPriority: number): number {
  return linearPriority === 0 ? 5 : linearPriority;
}

// --- Mutex ---

export class Mutex {
  private _lock: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this._lock;
    this._lock = next;
    await prev;
    return release;
  }
}

// --- InboxQueue ---

function readJsonl(path: string): QueueItem[] {
  if (!existsSync(path)) return [];
  try {
    const content = readFileSync(path, "utf-8");
    const items: QueueItem[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const item = safeParseJson<QueueItem>(trimmed);
      if (item) {
        if (!item.status) item.status = "pending"; // backward compat
        items.push(item);
      }
    }
    return items;
  } catch {
    return [];
  }
}

function writeJsonl(path: string, items: QueueItem[]): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  const content = items.map((item) => JSON.stringify(item)).join("\n") + (items.length ? "\n" : "");
  try {
    const fd = openSync(tmpPath, "w");
    try {
      writeSync(fd, content, 0, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup errors */
    }
    throw err;
  }
}

function appendJsonl(path: string, items: QueueItem[]): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const content = items.map((item) => JSON.stringify(item)).join("\n") + "\n";
  appendFileSync(path, content, "utf-8");
}

export class InboxQueue {
  private readonly mutex = new Mutex();

  constructor(private readonly path: string) {}

  /** Dedup and append entries to the queue. Returns count added. */
  async enqueue(entries: EnqueueEntry[]): Promise<number> {
    if (entries.length === 0) return 0;

    const release = await this.mutex.acquire();
    try {
      const existing = readJsonl(this.path);

      // Handle removal events — remove existing ticket items for affected issues
      const removalIds = new Set(
        entries
          .filter((e) => REMOVAL_EVENTS.has(e.event))
          .map((e) => e.id),
      );

      // Handle priority updates — update matching items' priority in-place
      const priorityUpdates = new Map(
        entries
          .filter((e) => e.event === "issue.priority_changed")
          .map((e) => [e.id, mapPriority(e.issuePriority)]),
      );

      let filtered = existing;
      let dirty = false;

      if (removalIds.size > 0) {
        filtered = existing.filter(
          (item) => !(removalIds.has(item.issueId) && item.event === "ticket"),
        );
        if (filtered.length !== existing.length) dirty = true;
      }

      if (priorityUpdates.size > 0) {
        for (const item of filtered) {
          const newPriority = priorityUpdates.get(item.issueId);
          if (newPriority !== undefined && item.priority !== newPriority) {
            item.priority = newPriority;
            dirty = true;
          }
        }
      }

      if (dirty) {
        writeJsonl(this.path, filtered);
      }

      // Build dedup set from remaining items using id + mapped queue event
      const existingKeys = new Set(
        filtered.map((item) => `${item.id}:${item.event}`),
      );

      const newItems: QueueItem[] = [];
      const now = new Date().toISOString();

      for (const entry of entries) {
        const queueEvent = QUEUE_EVENT[entry.event];
        if (!queueEvent) continue; // skip unmapped events

        const dedupKey = `${entry.id}:${queueEvent}`;
        if (existingKeys.has(dedupKey)) continue;

        newItems.push({
          id: entry.id,
          issueId: entry.issueId ?? entry.id,
          event: queueEvent,
          summary: entry.summary,
          priority: queueEvent === "mention" ? 0 : mapPriority(entry.issuePriority),
          addedAt: now,
          status: "pending",
        });
        existingKeys.add(dedupKey);
      }

      if (newItems.length > 0) {
        appendJsonl(this.path, newItems);
      }

      return newItems.length;
    } finally {
      release();
    }
  }

  /** Return pending items sorted by priority (lowest number first). Non-destructive. */
  async peek(): Promise<QueueItem[]> {
    const release = await this.mutex.acquire();
    try {
      const items = readJsonl(this.path).filter((i) => i.status === "pending");
      return items.sort((a, b) => a.priority - b.priority || a.addedAt.localeCompare(b.addedAt));
    } finally {
      release();
    }
  }

  /** Claim the highest-priority pending item (mark as in_progress), or null if none pending. */
  async pop(): Promise<QueueItem | null> {
    const release = await this.mutex.acquire();
    try {
      const items = readJsonl(this.path);
      const pending = items
        .filter((i) => i.status === "pending")
        .sort((a, b) => a.priority - b.priority || a.addedAt.localeCompare(b.addedAt));
      if (pending.length === 0) return null;

      const claimed = pending[0];
      claimed.status = "in_progress";
      writeJsonl(this.path, items);
      return claimed;
    } finally {
      release();
    }
  }

  /** Claim all pending items (mark as in_progress), return sorted by priority. */
  async drain(): Promise<QueueItem[]> {
    const release = await this.mutex.acquire();
    try {
      const items = readJsonl(this.path);
      const pending = items.filter((i) => i.status === "pending");
      if (pending.length === 0) return [];

      for (const item of pending) {
        item.status = "in_progress";
      }
      writeJsonl(this.path, items);

      return pending.sort((a, b) => a.priority - b.priority || a.addedAt.localeCompare(b.addedAt));
    } finally {
      release();
    }
  }

  /** Remove the in_progress item matching issueId. */
  async complete(issueId: string): Promise<boolean> {
    const release = await this.mutex.acquire();
    try {
      const items = readJsonl(this.path);
      const idx = items.findIndex(
        (i) => i.issueId === issueId && i.status === "in_progress",
      );
      if (idx === -1) return false;

      items.splice(idx, 1);
      writeJsonl(this.path, items);
      return true;
    } finally {
      release();
    }
  }

  /** Reset all in_progress items back to pending (crash recovery). */
  async recover(): Promise<number> {
    const release = await this.mutex.acquire();
    try {
      const items = readJsonl(this.path);
      let count = 0;
      for (const item of items) {
        if (item.status === "in_progress") {
          item.status = "pending";
          count++;
        }
      }
      if (count > 0) writeJsonl(this.path, items);
      return count;
    } finally {
      release();
    }
  }
}
