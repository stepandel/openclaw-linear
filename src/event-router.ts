import type { LinearWebhookPayload } from "./webhook-handler.js";

export type RouterAction = {
  type: "wake" | "notify";
  agentId: string;
  event: string;
  detail: string;
};

export type EventRouterConfig = {
  userMap: Record<string, string>;
  logger: {
    info: (message: string) => void;
    error: (message: string) => void;
  };
};

function extractMentionedUserIds(body: string): string[] {
  const matches = body.matchAll(/@([a-zA-Z0-9_-]+)/g);
  return [...matches].map((m) => m[1]);
}

function handleIssueUpdate(
  event: LinearWebhookPayload,
  config: EventRouterConfig,
): RouterAction[] {
  const changes = event.data.changes as
    | Record<string, { from?: unknown; to?: unknown }>
    | undefined;
  if (!changes?.assigneeId) return [];

  const actions: RouterAction[] = [];
  const { from: oldAssignee, to: newAssignee } = changes.assigneeId as {
    from?: string;
    to?: string;
  };
  const issueId = String(event.data.id ?? "unknown");

  if (newAssignee) {
    const agentId = config.userMap[newAssignee];
    if (agentId) {
      actions.push({
        type: "wake",
        agentId,
        event: "issue.assigned",
        detail: `Assigned to issue ${issueId}`,
      });
    } else {
      config.logger.info(
        `Unmapped Linear user ${newAssignee} assigned to ${issueId}`,
      );
    }
  }

  if (oldAssignee && !newAssignee) {
    const agentId = config.userMap[oldAssignee];
    if (agentId) {
      actions.push({
        type: "notify",
        agentId,
        event: "issue.unassigned",
        detail: `Unassigned from issue ${issueId}`,
      });
    } else {
      config.logger.info(
        `Unmapped Linear user ${oldAssignee} unassigned from ${issueId}`,
      );
    }
  }

  return actions;
}

function handleComment(
  event: LinearWebhookPayload,
  config: EventRouterConfig,
): RouterAction[] {
  const body = event.data.body as string | undefined;
  if (!body) return [];

  const mentionedIds = extractMentionedUserIds(body);
  const actions: RouterAction[] = [];
  const issueId = String(
    (event.data.issue as Record<string, unknown> | undefined)?.id ??
      event.data.issueId ??
      "unknown",
  );

  for (const userId of mentionedIds) {
    const agentId = config.userMap[userId];
    if (agentId) {
      actions.push({
        type: "wake",
        agentId,
        event: "comment.mention",
        detail: `Mentioned in comment on issue ${issueId}`,
      });
    } else {
      config.logger.info(
        `Unmapped Linear user ${userId} mentioned in comment on ${issueId}`,
      );
    }
  }

  return actions;
}

export function createEventRouter(config: EventRouterConfig) {
  return function route(event: LinearWebhookPayload): RouterAction[] {
    if (event.type === "Issue" && event.action === "update") {
      return handleIssueUpdate(event, config);
    }

    if (
      event.type === "Comment" &&
      (event.action === "create" || event.action === "update")
    ) {
      return handleComment(event, config);
    }

    return [];
  };
}
