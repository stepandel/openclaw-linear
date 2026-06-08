# openclaw-linear

Linear integration for [OpenClaw](https://github.com/openclaw/openclaw). Receives Linear webhook events, routes them through a persistent work queue, and gives agents tools to manage issues, comments, projects, teams, and relations via the Linear GraphQL API.

## Install

```bash
openclaw plugins install openclaw-linear
```

## Configuration

Each OpenClaw instance runs one agent — configure a separate instance per agent.

```yaml
plugins:
  linear:
    apiKey: "lin_api_..."                # Linear API key (required)
    webhookSecret: "your-signing-secret" # Webhook secret (required)
    # Or resolve the webhook secret at runtime:
    # webhookSecret:
    #   source: "env"
    #   provider: "process"
    #   id: "LINEAR_WEBHOOK_SECRET"
    # SecretRef requires an OpenClaw host that resolves secretInputs before activation.
    agentMapping:                        # Filter: only handle events for these Linear users
      "linear-user-uuid": "titus"
    teamIds: ["ENG", "OPS"]             # Optional: filter to specific teams (empty = all)
    eventFilter: ["Issue", "Comment"]    # Optional: filter event types (empty = all)
    debounceMs: 30000                    # Optional: batch window in ms (default: 30000)
    stateActions:                        # Optional: map state types/names to queue actions
      backlog: "add"
      unstarted: "add"
      started: "ignore"
      "In Review": "remove"             # State names override type matches (case-insensitive)
      completed: "remove"
      canceled: "remove"
```

### Config Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `apiKey` | string | **Yes** | Linear API key. Create at [linear.app/settings/account/security](https://linear.app/settings/account/security). |
| `webhookSecret` | string or SecretRef | **Yes** | Shared secret for HMAC webhook signature verification. SecretRef values require OpenClaw runtime secret input handling and must be resolved to a non-empty string before plugin activation. Use a string value on hosts without SecretRef resolution. |
| `agentMapping` | object | No | Maps Linear user UUIDs to agent IDs. Acts as a filter — events for unmapped users are ignored. Since each instance runs one agent, this typically has one entry. |
| `teamIds` | string[] | No | Team keys to scope webhook processing. Empty = all teams. |
| `eventFilter` | string[] | No | Event types to handle (`Issue`, `Comment`). Empty = all. |
| `debounceMs` | integer | No | Debounce window in milliseconds. Events within this window are batched into a single dispatch. Default: `30000` (30s). |
| `stateActions` | object | No | Maps Linear state types or names to queue actions (`"add"`, `"remove"`, `"ignore"`). See [State Actions](#state-actions). |

## Webhook Setup

1. **Make your endpoint publicly accessible.** The plugin registers at `/hooks/linear`:
   ```bash
   # Example with Tailscale Funnel
   tailscale funnel --bg 3000
   ```

2. **Register the webhook in Linear:**
   - Go to **Settings > API > Webhooks**
   - Set the URL to `https://your-host/hooks/linear`
   - Set the secret to match the resolved value of your `webhookSecret`
   - Select event types: Issues, Comments
   - Save

3. **Verify:** Assign a Linear issue to a mapped user — the agent should receive a notification.

## How It Works

```text
                         Linear Webhook POST
                                │
                                ▼
                  ┌───────────────────────────┐
                  │      Webhook Handler      │
                  │  HMAC verify · dedup (10m) │
                  └─────────────┬─────────────┘
                                │
                                ▼
                  ┌───────────────────────────┐
                  │       Event Router        │
                  │  team/type filter · user  │
                  │  mapping · state actions  │
                  └──────┬────────────┬───────┘
                         │            │
                     wake         notify
                     actions      actions
                         │            │
                         ▼            │
                  ┌──────────────┐    │
                  │   Debouncer  │    │
                  │  (30s batch) │    │
                  └──────┬───────┘    │
                         │            │
                         ▼            ▼
                  ┌───────────────────────────┐
                  │        Work Queue         │
                  │  JSONL · priority-sorted  │
                  │  dedup · crash recovery   │
                  └─────────────┬─────────────┘
                                │
                           added > 0?
                          yes/      \no
                           │         └─▶ (skip)
                           ▼
                  ┌───────────────────────────┐
                  │     Agent Dispatch        │
                  │  "N notification(s)       │
                  │   queued"                 │
                  └─────────────┬─────────────┘
                                │
                                ▼
                  ┌───────────────────────────┐
                  │          Agent            │
                  │  peek · pop · complete    │
                  └─────────────┬─────────────┘
                                │
                           on complete
                                │
                         items remain?
                          yes/      \no
                           │         └─▶ (idle)
                           ▼
                      auto-wake
                    (new session)
```

Events flow through four stages. The **webhook handler** verifies signatures and deduplicates deliveries. The **event router** filters by team, type, and user, then classifies each event as `wake` (needs the agent's attention now) or `notify` (queue silently). Wake actions pass through a **debouncer** that batches events within a configurable window. Both paths write to the **work queue** — a persistent, priority-sorted JSONL file. The agent is only woken when new items are actually added (deduplication may suppress a dispatch). After the agent completes an item, **auto-wake** checks for remaining work and starts a fresh session if needed.

## Work Queue

The work queue is the central data structure. Every webhook event that needs agent attention passes through it. No LLM tokens are spent on triage — queue writes are fully deterministic.

### Storage

Items are persisted to a JSONL file (`queue/inbox.jsonl` in the plugin data directory). File writes use atomic temp-file + fsync + rename to prevent corruption. A mutex serializes all operations to prevent race conditions.

### Item Lifecycle

```text
  webhook event
       │
       ▼
   ┌────────┐   pop/drain   ┌─────────────┐   complete   ┌─────────┐
   │pending │ ─────────────▶ │ in_progress │ ───────────▶ │ removed │
   └────────┘                └─────────────┘              └─────────┘
       │                            │
       │  removal event             │  crash recovery
       ▼                            ▼
   (removed)                   (→ pending)
```

1. **Enqueue** — webhook events create `pending` items, deduped by `issueId:event`
2. **Claim** — `pop` (single) or `drain` (all) moves items to `in_progress`
3. **Complete** — removes the `in_progress` item from the file
4. **Crash recovery** — on startup, all `in_progress` items reset to `pending`

### Priority Sorting

Items sort by Linear priority (1 = urgent, 4 = low). Priority 0 (none) maps to 5 so unprioritized items sort last. Ties break by timestamp (oldest first). Priority changes from Linear update items in-place.

### Deduplication

Each item has a dedup key of `issueId:event` (e.g. `ENG-42:ticket`). The same issue can appear twice with different event types (one ticket + one mention). If a duplicate already exists in the queue (any status), the new entry is skipped.

### Removal Events

When an issue is unassigned, reassigned away, or moved to a `remove` state, any matching `ticket` item is removed from the queue — even if already `in_progress`. This prevents the agent from working on stale assignments.

### Queue Events

| Agent Event | Queue Event | Behavior |
|---|---|---|
| `issue.assigned` | `ticket` | Enqueue + wake |
| `issue.state_readded` | `ticket` | Enqueue + wake |
| `comment.mention` | `mention` | Enqueue + wake |
| `issue.unassigned` | — | Remove ticket |
| `issue.reassigned` | — | Remove ticket |
| `issue.state_removed` | — | Remove ticket |
| `issue.priority_changed` | — | Update priority in-place |

### Agent Tool

The `linear_queue` tool gives agents four actions:

| Action | Description |
|--------|-------------|
| `peek` | View all pending items sorted by priority |
| `pop` | Claim the highest-priority pending item |
| `drain` | Claim all pending items at once |
| `complete` | Finish work on a claimed item (requires `issueId`) |

## Tools

The plugin provides six tools. All use an `action` parameter to select the operation.

### `linear_issue` — issue management

| Action | Required | Optional |
|--------|----------|----------|
| `view` | `issueId` | — |
| `list` | — | `state`, `assignee`, `team`, `project`, `limit` |
| `create` | `title` | `description`, `assignee`, `state`, `priority`, `team`, `project`, `parent`, `labels` |
| `update` | `issueId` | `title`, `description`, `assignee`, `state`, `priority`, `labels`, `project` |
| `delete` | `issueId` | — |

Issues are referenced by human-readable identifiers (e.g. `ENG-123`). Names are resolved automatically — `assignee` accepts display names or emails, `state` accepts workflow state names, `team` accepts team keys, and `labels` accepts label names.

### `linear_comment` — comments

| Action | Required | Optional |
|--------|----------|----------|
| `list` | `issueId` | — |
| `add` | `issueId`, `body` | `parentCommentId` |
| `update` | `commentId`, `body` | — |

### `linear_team` — teams and members

| Action | Required |
|--------|----------|
| `list` | — |
| `members` | `team` (key, e.g. `ENG`) |

### `linear_project` — projects

| Action | Required | Optional |
|--------|----------|----------|
| `list` | — | `team`, `status` |
| `view` | `projectId` | — |
| `create` | `name` | `team`, `description` |

### `linear_relation` — issue relations

| Action | Required |
|--------|----------|
| `list` | `issueId` |
| `add` | `issueId`, `type`, `relatedIssueId` |
| `delete` | `relationId` |

Relation types: `blocks`, `blocked-by`, `related`, `duplicate`.

## Routed Events

| Linear Event | Router Action | Agent Event |
|---|---|---|
| Issue assigned to mapped user | `wake` | `issue.assigned` |
| Issue unassigned from mapped user | `notify` | `issue.unassigned` |
| Issue reassigned away from mapped user | `notify` | `issue.reassigned` |
| Issue state change → `add` action | `wake` | `issue.state_readded` |
| Issue state change → `remove` action | `notify` | `issue.state_removed` |
| @mention in comment (mapped user) | `wake` | `comment.mention` |

`wake` events pass through the debouncer and dispatch to the agent. `notify` events write directly to the queue without waking.

## State Actions

When an issue's state changes, the plugin resolves what to do based on the `stateActions` config. This controls which state transitions re-add issues to the queue (e.g. bounced back from testing) vs. remove them (e.g. done/canceled) vs. are ignored (e.g. in progress).

**Resolution order:** state name match → state type match → built-in default.

Linear has 6 fixed state types. Custom state names (e.g. "In Review", "QA") are team-specific but always belong to one of these types.

**Built-in defaults** (used when `stateActions` is not configured or a state isn't mapped):

| State Type | Default Action |
|---|---|
| `triage` | `ignore` |
| `backlog` | `add` |
| `unstarted` | `add` |
| `started` | `ignore` |
| `completed` | `remove` |
| `canceled` | `remove` |

**Actions:**

- `"add"` — re-add the issue to the queue as a ticket and wake the agent
- `"remove"` — remove the issue's ticket from the queue
- `"ignore"` — do nothing (default for unmapped states)

## Architecture

```text
src/
├── index.ts                 # Plugin entry point, activation, dispatch logic
├── webhook-handler.ts       # HMAC verification, body parsing, dedup
├── event-router.ts          # Event filtering, routing, state action resolution
├── linear-api.ts            # GraphQL client, name/ID resolution helpers
├── work-queue.ts            # Persistent JSONL queue with priority sorting
└── tools/
    ├── queue-tool.ts        # linear_queue — notification inbox management
    ├── linear-issue-tool.ts # linear_issue — CRUD for issues
    ├── linear-comment-tool.ts # linear_comment — issue comments
    ├── linear-team-tool.ts  # linear_team — teams and members
    ├── linear-project-tool.ts # linear_project — project management
    └── linear-relation-tool.ts # linear_relation — issue relations
```

## Development

```bash
npm install
npm run build
npm test
```
