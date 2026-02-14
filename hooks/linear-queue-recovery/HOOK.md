# linear-queue-recovery

🔄 Reset stale queue items on gateway startup.

## Events

- `gateway:startup`

## Requirements

- Workspace directory configured
- `queue/work-queue.json` path relative to workspace

## Behavior

1. Reads `queue/work-queue.json` (no-op if missing)
2. Finds items with status `in_progress`
3. Resets them to `pending` (clears `startedAt`)
4. Logs recovery actions
5. Writes updated queue file

Ensures no tasks get stuck after crashes or restarts.
