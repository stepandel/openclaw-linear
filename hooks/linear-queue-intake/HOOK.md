# linear-queue-intake

📥 Deterministic notification parsing into work queue.

## Events

Triggered by Linear plugin notification dispatch (consolidated message from `formatConsolidatedMessage`).

## Requirements

- Workspace directory configured
- `queue/work-queue.json` path relative to workspace

## Behavior

1. Parses consolidated notification messages into structured queue items
2. Assigns priority: `issue.assigned` (priority 1) > `comment.mention` (priority 2)
3. Deduplicates by `issueId + event` against existing queue
4. Appends new items with status `pending`
5. Writes queue file atomically (read → modify → write)

**No LLM calls** — purely deterministic parsing.
