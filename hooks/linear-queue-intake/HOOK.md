# linear-queue-intake

📥 Deterministic notification parsing into work queue.

## Events

Triggered by Linear plugin notification dispatch (consolidated message from `formatConsolidatedMessage`).

## Requirements

- Workspace directory configured
- `queue/work-queue.json` path relative to workspace

## Behavior

1. Parses consolidated notification messages into structured queue items
2. Assigns priority: `issue.assigned` (1) > `issue.reassigned` (2) > `comment.mention` (3) > `issue.unassigned` (4)
3. Deduplicates by `issueId + event` against existing queue
4. Appends new items with status `pending`
5. Writes queue file atomically (read → modify → write)

**No LLM calls** — purely deterministic parsing.
