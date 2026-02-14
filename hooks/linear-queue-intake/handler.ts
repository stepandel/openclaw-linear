import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync } from "node:fs";
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

const EVENT_PRIORITY: Record<string, number> = {
  "issue.assigned": 1,
  "issue.reassigned": 2,
  "comment.mention": 3,
  "issue.unassigned": 4,
};

/**
 * Parse a single notification line into a partial queue item.
 * Handles both formats:
 *   - Single: "Assigned to issue ENG-42: Fix login bug"
 *   - Multi:  "1. [Assigned] ENG-42: Fix login bug"
 */
function parseNotificationLine(line: string): { id: string; event: string; summary: string } | null {
  // Multi-notification with quoted comment: "N. [Mentioned] TEAM-123: "comment text""
  // Must be checked before multiMatch since multiMatch would also match Mentioned lines
  const mentionMatch = line.match(
    /^\d+\.\s+\[Mentioned\]\s+([A-Z]+-\d+):\s*"(.+)"$/,
  );
  if (mentionMatch) {
    const [, id, summary] = mentionMatch;
    return { id, event: "comment.mention", summary: summary.trim() };
  }

  // Multi-notification format: "N. [Label] TEAM-123: summary"
  const multiMatch = line.match(
    /^\d+\.\s+\[(\w+(?:\s+\w+)?)\]\s+([A-Z]+-\d+):\s*(.+)$/,
  );
  if (multiMatch) {
    const [, label, id, summary] = multiMatch;
    const event = labelToEvent(label);
    return { id, event, summary: summary.trim() };
  }

  // Single notification: "Assigned to issue TEAM-123: summary"
  const assignedMatch = line.match(/^Assigned to issue ([A-Z]+-\d+):\s*(.+)$/);
  if (assignedMatch) {
    return { id: assignedMatch[1], event: "issue.assigned", summary: assignedMatch[2].trim() };
  }

  // Single: "Unassigned from issue TEAM-123: summary"
  const unassignedMatch = line.match(/^Unassigned from issue ([A-Z]+-\d+):\s*(.+)$/);
  if (unassignedMatch) {
    return { id: unassignedMatch[1], event: "issue.unassigned", summary: unassignedMatch[2].trim() };
  }

  // Single: "Reassigned away from issue TEAM-123: summary"
  const reassignedMatch = line.match(/^Reassigned away from issue ([A-Z]+-\d+):\s*(.+)$/);
  if (reassignedMatch) {
    return { id: reassignedMatch[1], event: "issue.reassigned", summary: reassignedMatch[2].trim() };
  }

  // Single: "Mentioned in comment on issue TEAM-123: summary\n\n> body"
  const mentionedMatch = line.match(/^Mentioned in comment on issue ([A-Z]+-\d+):\s*(.+?)(?:\n|$)/);
  if (mentionedMatch) {
    return { id: mentionedMatch[1], event: "comment.mention", summary: mentionedMatch[2].trim() };
  }

  return null;
}

function labelToEvent(label: string): string {
  const map: Record<string, string> = {
    Assigned: "issue.assigned",
    Unassigned: "issue.unassigned",
    Reassigned: "issue.reassigned",
    Mentioned: "comment.mention",
  };
  return map[label] ?? `unknown.${label.toLowerCase()}`;
}

/**
 * Parse a consolidated notification message into queue item candidates.
 */
export function parseNotificationMessage(
  message: string,
): Array<{ id: string; event: string; summary: string }> {
  const results: Array<{ id: string; event: string; summary: string }> = [];

  // Check if multi-notification format
  if (message.startsWith("You have ")) {
    const lines = message.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const parsed = parseNotificationLine(line.trim());
      if (parsed) results.push(parsed);
    }
  } else {
    // Single notification
    const parsed = parseNotificationLine(message.trim());
    if (parsed) results.push(parsed);
  }

  return results;
}

function readQueue(queuePath: string): WorkQueue {
  if (!existsSync(queuePath)) {
    return { items: [] };
  }
  try {
    const data = readFileSync(queuePath, "utf-8");
    return JSON.parse(data) as WorkQueue;
  } catch {
    return { items: [] };
  }
}

function writeQueue(queuePath: string, queue: WorkQueue): void {
  const dir = dirname(queuePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${queuePath}.tmp.${process.pid}.${Date.now()}`;
  const content = JSON.stringify(queue, null, 2) + "\n";
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
}

/**
 * Process a consolidated notification message and append new items to the work queue.
 * Returns the number of new items added.
 */
export default function handleIntake(
  message: string,
  workspaceDir: string,
): number {
  const queuePath = join(workspaceDir, "queue", "work-queue.json");
  const parsed = parseNotificationMessage(message);

  if (parsed.length === 0) return 0;

  const queue = readQueue(queuePath);

  const existingKeys = new Set(
    queue.items.map((item) => `${item.issueId ?? item.id}:${item.event}`),
  );

  let added = 0;
  const now = new Date().toISOString();

  for (const entry of parsed) {
    const dedupKey = `${entry.id}:${entry.event}`;
    if (existingKeys.has(dedupKey)) continue;

    const item: QueueItem = {
      id: entry.id,
      issueId: entry.id, // Use ticket ID as issueId when UUID not available from message
      event: entry.event,
      summary: entry.summary,
      status: "pending",
      priority: EVENT_PRIORITY[entry.event] ?? 5,
      addedAt: now,
      startedAt: null,
      completedAt: null,
    };

    queue.items.push(item);
    existingKeys.add(dedupKey);
    added++;
  }

  if (added > 0) {
    // Sort by priority (lower = higher priority)
    queue.items.sort((a, b) => a.priority - b.priority);
    writeQueue(queuePath, queue);
  }

  return added;
}
