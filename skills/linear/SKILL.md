---
name: linear
description: Linear project management integration. Provides tools for processing a notification queue, managing issues, comments, teams, projects, and issue relations via the Linear GraphQL API.
metadata: { "openclaw": { "always": true, "emoji": "📐", "requires": { "config": ["extensions.openclaw-linear"] } } }
---

# Linear

You have Linear tools for managing issues and responding to notifications. These tools call the Linear GraphQL API directly — they handle auth, formatting, and error handling for you.

## Tools

### `linear_queue` — notification inbox

Manages the queue of Linear notifications routed to you by webhooks.

| Action | Effect |
|---|---|
| `peek` | View all pending items sorted by priority. Non-destructive. |
| `pop` | Claim the highest-priority pending item (marks it `in_progress`). |
| `drain` | Claim all pending items (marks them `in_progress`). |
| `complete` | Finish work on a claimed item (requires `issueId`). Removes it from the queue. |

Queue items have this shape:

```json
{
  "id": "TEAM-123",
  "issueId": "TEAM-123",
  "event": "ticket",
  "summary": "Issue title or comment text",
  "priority": 1,
  "status": "pending",
  "addedAt": "ISO timestamp"
}
```

Event types:

| Event | Meaning |
|---|---|
| `ticket` | You have a ticket to work on. |
| `mention` | You were mentioned in a comment. |

For `ticket` events, `id` and `issueId` are the same (the issue identifier). For `mention` events, `id` is the comment ID and `issueId` is the parent issue identifier. Always use `issueId` when calling `linear_issue`, `linear_comment`, or `linear_queue complete`.

Priority maps from the Linear issue (1=Urgent, 2=High, 3=Medium, 4=Low, 5=None). Mentions always get priority 0, so they are processed before any ticket. Higher-priority items are popped first.

### `linear_issue` — manage issues

Manage Linear issues: view details, search/filter, create, update, and delete.

| Action | Required Params | Optional Params |
|---|---|---|
| `view` | `issueId` | — |
| `list` | — | `state`, `assignee`, `team`, `project`, `limit` |
| `create` | `title` | `description`, `assignee`, `state`, `priority`, `team`, `project`, `parent`, `labels`, `dueDate` |
| `update` | `issueId` | `title`, `description`, `appendDescription`, `assignee`, `state`, `priority`, `labels`, `project`, `dueDate` |
| `delete` | `issueId` | — |

- `issueId` accepts human-readable identifiers like `ENG-123`
- `assignee` accepts display name or email
- `state` accepts workflow state name (e.g. `In Progress`, `Done`)
- `team` accepts team key (e.g. `ENG`)
- `priority` is numeric: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low
- `labels` is an array of label names
- `parent` accepts a parent issue identifier for creating sub-issues
- `appendDescription` (boolean) — when true, appends `description` to the existing description instead of replacing it (update only)
- `dueDate` accepts a date string in `YYYY-MM-DD` format (e.g. `2025-12-31`); pass an empty string to clear the due date
- `description` supports markdown. **Use actual newlines for line breaks, not `\n` escape sequences** — literal `\n` will appear as-is in the ticket instead of creating line breaks

### `linear_comment` — manage comments

Read, create, and update comments on Linear issues.

| Action | Required Params | Optional Params |
|---|---|---|
| `list` | `issueId` | — |
| `add` | `issueId`, `body` | `parentCommentId` |
| `update` | `commentId`, `body` | — |

- `body` supports markdown. **Use actual newlines for line breaks, not `\n` escape sequences** — literal `\n` will appear as-is in the comment instead of creating line breaks
- `parentCommentId` threads the comment as a reply

### `linear_team` — teams and members

View teams and their members.

| Action | Required Params | Optional Params |
|---|---|---|
| `list` | — | — |
| `members` | `team` | — |

- `team` is the team key (e.g. `ENG`)

### `linear_project` — manage projects

List, view, and create Linear projects.

| Action | Required Params | Optional Params |
|---|---|---|
| `list` | — | `team`, `status` |
| `view` | `projectId` | — |
| `create` | `name` | `team`, `description` |

### `linear_relation` — issue relations

Manage relations between Linear issues (blocks, blocked-by, related, duplicate).

| Action | Required Params | Optional Params |
|---|---|---|
| `list` | `issueId` | — |
| `add` | `issueId`, `type`, `relatedIssueId` | — |
| `delete` | `relationId` | — |

- `type` is one of: `blocks`, `blocked-by`, `related`, `duplicate`

## Processing workflow

When you receive a Linear notification:

1. **Peek** with `linear_queue { action: "peek" }` to see all pending items.
2. **Skip** if there are no items.
3. **Pop** the next item with `linear_queue { action: "pop" }`. This claims it (status becomes `in_progress`).
4. **Read** the issue with `linear_issue { action: "view", issueId: "<id>" }`.
5. **Read comments** with `linear_comment { action: "list", issueId: "<id>" }` if the event is a mention or you need discussion context.
6. **Act** on the item:
   - `ticket` — do the work, then update state with `linear_issue { action: "update", ... }`.
   - `mention` — read the thread and reply with `linear_comment { action: "add", ... }`.
7. **Complete** with `linear_queue { action: "complete", issueId: "<id>" }` to remove it from the queue.
8. **Repeat** from step 3 until pop returns null.

## Optional X/Twitter evidence

If a Linear item asks for public X/Twitter research and TweetClaw is also installed, use TweetClaw for search tweets, search tweet replies, follower export, user lookup, media references, monitors, webhooks, giveaway draws, and approval-gated post tweet or reply actions. Keep openclaw-linear responsible for the Linear queue, issue updates, and comments.

When adding TweetClaw findings to Linear, include the source query, tweet IDs or URLs, capture date, concise summary, confidence, and next action. Do not paste raw timelines, account credentials, or direct-message contents into Linear unless the workspace policy explicitly allows it.
