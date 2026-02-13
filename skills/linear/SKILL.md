# Linear Tools — Agent Skill

This skill provides four tools for interacting with Linear issues directly from an OpenClaw agent.

## Tools

### `linear_list_issues`

List issues from Linear with optional filters.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `state` | string | No | Filter by workflow state name (e.g. `In Progress`, `Done`) |
| `assignee` | string | No | Filter by assignee display name |
| `team` | string | No | Filter by team key (e.g. `ENG`) |
| `labels` | string[] | No | Filter by label names |

**Example:**
```text
List my assigned in-progress issues:
linear_list_issues { "state": "In Progress", "assignee": "Titus" }
```

---

### `linear_create_issue`

Create a new issue in Linear.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `title` | string | **Yes** | Issue title |
| `teamId` | string | **Yes** | Team key or ID (e.g. `ENG`) |
| `description` | string | No | Issue description (markdown) |
| `labels` | string[] | No | Label names to apply |
| `priority` | number | No | 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low |
| `assignee` | string | No | Assignee email address |

**Example:**
```text
linear_create_issue { "title": "Fix auth bug", "teamId": "ENG", "priority": 2, "description": "Users can't log in after password reset" }
```

---

### `linear_update_issue`

Update an existing Linear issue (state, assignee, priority, or description).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `issueId` | string | **Yes** | Issue identifier (e.g. `ENG-123`) |
| `state` | string | No | New workflow state name (e.g. `In Progress`, `Done`) |
| `assignee` | string | No | New assignee email address |
| `priority` | number | No | 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low |
| `description` | string | No | New description (markdown) |

**Example:**
```text
linear_update_issue { "issueId": "ENG-123", "state": "In Progress" }
```

---

### `linear_add_comment`

Add a comment to an existing Linear issue.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `issueId` | string | **Yes** | Issue identifier (e.g. `ENG-123`) |
| `body` | string | **Yes** | Comment body (markdown) |

**Example:**
```text
linear_add_comment { "issueId": "ENG-123", "body": "PR submitted: https://github.com/org/repo/pull/42" }
```
