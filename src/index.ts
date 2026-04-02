import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createWebhookHandler } from "./webhook-handler.js";
import { createEventRouter, type RouterAction } from "./event-router.js";
import { InboxQueue, type EnqueueEntry } from "./work-queue.js";
import { createQueueTool } from "./tools/queue-tool.js";
import { setApiKey } from "./linear-api.js";
import { createIssueTool } from "./tools/linear-issue-tool.js";
import { createCommentTool } from "./tools/linear-comment-tool.js";
import { createTeamTool } from "./tools/linear-team-tool.js";
import { createProjectTool } from "./tools/linear-project-tool.js";
import { createRelationTool } from "./tools/linear-relation-tool.js";

const CHANNEL_ID = "linear";
const DEFAULT_DEBOUNCE_MS = 30_000;

const EVENT_LABELS: Record<string, string> = {
  "issue.assigned": "Assigned",
  "issue.unassigned": "Unassigned",
  "issue.reassigned": "Reassigned",
  "issue.removed": "Removed",
  "issue.state_removed": "State Removed",
  "issue.state_readded": "State Re-added",
  "issue.priority_changed": "Priority Changed",
  "comment.mention": "Mentioned",
};

export function formatConsolidatedMessage(actions: RouterAction[]): string {
  if (actions.length === 1) {
    return actions[0].detail;
  }

  const lines = actions.map((a, i) => {
    const label = EVENT_LABELS[a.event] ?? a.event;
    const summary = formatActionSummary(a);
    return `${i + 1}. [${label}] ${summary}`;
  });

  return `You have ${actions.length} new Linear notifications:\n\n${lines.join("\n")}\n\nReview and prioritize before starting work.`;
}

function formatActionSummary(action: RouterAction): string {
  if (action.event === "comment.mention") {
    const bodyStart = action.detail.indexOf("\n\n> ");
    if (bodyStart !== -1) {
      const quote = action.detail.slice(bodyStart + 4); // skip "\n\n> "
      return `${action.issueLabel}: "${quote}"`;
    }
  }

  return action.issueLabel || action.detail;
}

async function dispatchConsolidatedActions(
  actions: RouterAction[],
  api: OpenClawPluginApi,
  queue: InboxQueue,
): Promise<void> {
  if (actions.length === 0) return;

  const core = api.runtime;
  const cfg = api.config;

  const first = actions[0];

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: "default",
    peer: {
      kind: "direct" as const,
      id: first.linearUserId,
    },
  });

  // Write to queue deterministically — no LLM involved
  const entries: EnqueueEntry[] = actions.map((a) => ({
    id: a.commentId || a.identifier,
    issueId: a.identifier,
    event: a.event,
    summary: a.issueLabel,
    issuePriority: a.issuePriority,
  }));
  const added = await queue.enqueue(entries);

  if (added === 0) {
    api.logger.info("[linear] All notifications deduped — skipping agent dispatch");
    return;
  }

  // Agent gets a minimal notification pointing to the linear_queue tool
  const body = `${added} new Linear notification(s) queued. Use the linear_queue tool to process them.`;

  const ctx = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: body,
    RawBody: body,
    CommandBody: body,
    From: `${CHANNEL_ID}:${first.linearUserId}`,
    To: `${CHANNEL_ID}:${route.agentId ?? first.agentId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? "default",
    ChatType: "direct",
    ConversationLabel: `Linear: batch (${actions.length} events)`,
    SenderId: first.linearUserId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:${first.linearUserId}`,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async () => {
        // No-op: agent uses Linear tools to respond to specific issues after triage
      },
      onError: (err: unknown) => {
        api.logger.error(
          `[linear] Reply error: ${formatErrorMessage(err)}`,
        );
      },
    },
  });
}

let activeDebouncer: { flushKey: (key: string) => Promise<void> } | undefined;
const activeDebouncerKeys = new Set<string>();

export function activate(api: OpenClawPluginApi): void {
  api.logger.info("Linear plugin activated");

  const linearApiKey = api.pluginConfig?.["apiKey"];
  if (typeof linearApiKey !== "string" || !linearApiKey) {
    api.logger.error("[linear] apiKey is not configured — plugin is inert");
    return;
  }
  setApiKey(linearApiKey);

  const webhookSecret = api.pluginConfig?.["webhookSecret"];
  if (typeof webhookSecret !== "string" || !webhookSecret) {
    api.logger.error("[linear] webhookSecret is not configured — plugin is inert");
    return;
  }

  const agentMapping =
    (api.pluginConfig?.["agentMapping"] as Record<string, string>) ?? {};
  if (Object.keys(agentMapping).length === 0) {
    api.logger.info("[linear] agentMapping is empty — all events will be dropped");
  }

  const eventFilter =
    (api.pluginConfig?.["eventFilter"] as string[]) ?? [];
  const teamIds =
    (api.pluginConfig?.["teamIds"] as string[]) ?? [];
  const rawDebounceMs = api.pluginConfig?.["debounceMs"] as number | undefined;
  const debounceMs =
    (typeof rawDebounceMs === "number" && rawDebounceMs > 0)
      ? rawDebounceMs
      : DEFAULT_DEBOUNCE_MS;

  const core = api.runtime;
  const cfg = api.config;

  const queuePath = api.resolvePath("queue/inbox.jsonl");
  const queue = new InboxQueue(queuePath);

  // Recover any stale in_progress items from a previous crash
  queue.recover().then((count) => {
    if (count > 0) {
      api.logger.info(`[linear] Recovered ${count} stale in_progress queue item(s)`);
    }
  }).catch((err) => {
    api.logger.error(
      `[linear] Queue recovery failed: ${formatErrorMessage(err)}`,
    );
  });

  api.registerTool(createQueueTool(queue));
  api.registerTool(createIssueTool());
  api.registerTool(createCommentTool());
  api.registerTool(createTeamTool());
  api.registerTool(createProjectTool());
  api.registerTool(createRelationTool());

  // Auto-wake: after a "complete" action, dispatch a fresh session if items remain
  api.on("after_tool_call", async (event) => {
    if (event.toolName !== "linear_queue") return;
    if (event.params.action !== "complete") return;
    if (event.error) return;

    const remaining = await queue.peek();
    if (remaining.length === 0) return;

    const remainingCount = remaining.length;
    const peerId = `queue-wake-${Date.now()}`;
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: CHANNEL_ID,
      accountId: "default",
      peer: { kind: "direct" as const, id: peerId },
    });

    const body = `${remainingCount} item(s) remaining in queue. Use the linear_queue tool to continue processing.`;

    const ctx = core.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: body,
      RawBody: body,
      CommandBody: body,
      From: `${CHANNEL_ID}:${peerId}`,
      To: `${CHANNEL_ID}:${route.agentId ?? "default"}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId ?? "default",
      ChatType: "direct",
      ConversationLabel: `Linear: queue check (${remainingCount} remaining)`,
      SenderId: peerId,
      Provider: CHANNEL_ID,
      Surface: CHANNEL_ID,
      OriginatingChannel: CHANNEL_ID,
      OriginatingTo: `${CHANNEL_ID}:${peerId}`,
    });

    core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        deliver: async () => {},
        onError: (err: unknown) => {
          api.logger.error(
            `[linear] Queue wake error: ${formatErrorMessage(err)}`,
          );
        },
      },
    }).catch((err) => {
      api.logger.error(
        `[linear] Queue wake dispatch failed: ${formatErrorMessage(err)}`,
      );
    });
  });

  const stateActions =
    (api.pluginConfig?.["stateActions"] as Record<string, string>) ?? undefined;

  const routeEvent = createEventRouter({
    agentMapping,
    logger: api.logger,
    eventFilter: eventFilter.length ? eventFilter : undefined,
    teamIds: teamIds.length ? teamIds : undefined,
    stateActions,
  });

  const debouncer = api.runtime.channel.debounce.createInboundDebouncer<RouterAction>({
    debounceMs,
    buildKey: (action) => action.agentId,
    shouldDebounce: () => true,
    onFlush: async (actions) => {
      await dispatchConsolidatedActions(actions, api, queue);
    },
    onError: (err) => {
      api.logger.error(
        `[linear] Debounce flush failed: ${formatErrorMessage(err)}`,
      );
    },
  });
  activeDebouncer = debouncer;

  const handler = createWebhookHandler({
    webhookSecret,
    logger: api.logger,
    onEvent: (event) => {
      const actions = routeEvent(event);
      for (const action of actions) {
        api.logger.info(
          `[event-router] ${action.type} agent=${action.agentId} event=${action.event}: ${action.detail}`,
        );

        if (action.type === "wake") {
          activeDebouncerKeys.add(action.agentId);
          debouncer.enqueue(action);
        }

        if (action.type === "notify") {
          queue
            .enqueue([
              {
                id: action.commentId || action.identifier,
                issueId: action.identifier,
                event: action.event,
                summary: action.issueLabel,
                issuePriority: action.issuePriority,
              },
            ])
            .catch((err) =>
              api.logger.error(
                `[linear] Notify enqueue error: ${formatErrorMessage(err)}`,
              ),
            );
        }
      }
    },
  });

  api.registerHttpRoute({
    path: "/hooks/linear",
    handler,
  });

  api.logger.info(
    `Linear webhook handler registered at /hooks/linear (debounce: ${debounceMs}ms)`,
  );
}

export async function deactivate(api: OpenClawPluginApi): Promise<void> {
  if (activeDebouncer) {
    for (const key of activeDebouncerKeys) {
      await activeDebouncer.flushKey(key);
    }
    activeDebouncerKeys.clear();
    activeDebouncer = undefined;
  }
  api.logger.info("Linear plugin deactivated");
}

const plugin = {
  id: "openclaw-linear",
  name: "Linear",
  description: "Linear project management integration for OpenClaw",
  activate,
  deactivate,
} satisfies {
  id: string;
  name: string;
  description: string;
  activate: (api: OpenClawPluginApi) => void;
  deactivate: (api: OpenClawPluginApi) => Promise<void>;
};

export default plugin;
