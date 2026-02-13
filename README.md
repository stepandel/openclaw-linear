# @openclaw/linear

Linear project management integration for OpenClaw. Provides webhook-driven notifications and CRUD tools for agents to interact with Linear issues.

## Features

- **Webhook handler** — receives Linear webhook events with HMAC signature verification
- **Event router** — routes issue assignments and comment mentions to the right agent
- **Agent tools** — list, create, update issues and add comments directly from agents
- **Push notifications** — replaces heartbeat polling with real-time webhook delivery

## Install

```bash
npm install @openclaw/linear
```

## Configuration

Add the plugin to your OpenClaw config:

```yaml
plugins:
  linear:
    apiKey: "lin_api_xxxxxxxxxxxx"
    webhookSecret: "your-webhook-signing-secret"
    teamIds: ["ENG", "OPS"]          # Optional: filter to specific teams (empty = all)
    eventFilter: ["Issue", "Comment"] # Optional: filter event types (empty = all)
    agentMapping:                     # Map Linear user IDs → OpenClaw agent IDs
      "linear-user-uuid-1": "titus"
      "linear-user-uuid-2": "scout"
```

### Config Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `apiKey` | string | **Yes** | Linear API key. Generate at **Settings > API > Personal API keys** in Linear. |
| `webhookSecret` | string | **Yes** | Shared secret for HMAC webhook signature verification. |
| `teamIds` | string[] | No | Team keys to scope webhook processing. Empty array = all teams. |
| `eventFilter` | string[] | No | Event types to handle (`Issue`, `Comment`, etc.). Empty = all. |
| `agentMapping` | object | No | Maps Linear user UUIDs to OpenClaw agent IDs for notification routing. |

## Webhook Setup

1. **Make your endpoint publicly accessible.** The plugin listens at `/webhooks/linear`. Use Tailscale Funnel, ngrok, or a public server:
   ```bash
   # Example with Tailscale Funnel
   tailscale funnel --bg 3000
   ```

2. **Register the webhook in Linear:**
   - Go to **Settings > API > Webhooks** in your Linear workspace
   - Click **New webhook**
   - Set the URL to `https://your-host/webhooks/linear`
   - Set the secret to match your `webhookSecret` config value
   - Select the event types you want (Issues, Comments, etc.)
   - Save

3. **Verify it works:** Assign a Linear issue to a mapped user — the corresponding agent should receive a wake event.

## End-to-End Flow

```text
Linear ticket assigned → Linear sends webhook POST
  → Plugin verifies HMAC signature
  → Event router matches assignee to agent via agentMapping
  → Agent receives wake/notify event
  → Agent uses Linear tools to update the issue
```

## Agent Tools

Once the plugin is active, agents get four tools. See [`skills/linear/SKILL.md`](skills/linear/SKILL.md) for full documentation.

| Tool | Description |
|------|-------------|
| `linear_list_issues` | List issues with filters (state, assignee, team, labels) |
| `linear_create_issue` | Create a new issue |
| `linear_update_issue` | Update issue state, assignee, priority, description |
| `linear_add_comment` | Add a comment to an issue |

## Fallback: Heartbeat Polling

If webhook delivery fails (network issues, endpoint down), agents can fall back to heartbeat-based polling:

```markdown
# In agent's HEARTBEAT.md
- [ ] Check Linear for new assignments: `linear_list_issues { "assignee": "Me", "state": "Todo" }`
- [ ] Process any new issues found
```

This is a safety net — under normal operation, webhooks provide real-time delivery. Monitor webhook health in Linear's webhook settings page (shows delivery status and recent failures).

## Development

```bash
npm install
npm run build

# Type-check without emitting
npx tsc --noEmit

# Run tests
npm test
```
