import type { LinearWebhookPayload } from "./webhook-handler.js";

export type RouterAction = {
  type: "wake" | "notify";
  agentId: string;
  event: string;
  detail: string;
  issueId: string;
  issueLabel: string;
  identifier: string;
  issuePriority: number;
  linearUserId: string;
  /** Comment ID for mention events — used as dedup key in the queue. */
  commentId?: string;
};

export type StateAction = "add" | "remove" | "ignore";

export type EventRouterConfig = {
  agentMapping: Record<string, string>;
  logger: {
    info: (message: string) => void;
    error: (message: string) => void;
  };
  eventFilter?: string[];
  teamIds?: string[];
  stateActions?: Record<string, string>;
};

export const DEFAULT_STATE_ACTIONS: Record<string, StateAction> = {
  triage: "ignore",
  backlog: "add",
  unstarted: "add",
  started: "ignore",
  completed: "remove",
  canceled: "remove",
};

export function resolveStateAction(
  config: EventRouterConfig,
  stateType: string | undefined,
  stateName: string | undefined,
): StateAction {
  if (config.stateActions) {
    // Build lowercase lookup from config
    const lookup = new Map<string, string>();
    for (const [key, value] of Object.entries(config.stateActions)) {
      lookup.set(key.toLowerCase(), value);
    }

    // Check state name first (case-insensitive)
    if (stateName) {
      const byName = lookup.get(stateName.toLowerCase());
      if (byName === "add" || byName === "remove" || byName === "ignore") {
        return byName;
      }
    }

    // Check state type
    if (stateType) {
      const byType = lookup.get(stateType.toLowerCase());
      if (byType === "add" || byType === "remove" || byType === "ignore") {
        return byType;
      }
    }
  }

  // Fall back to built-in defaults
  if (stateType && stateType in DEFAULT_STATE_ACTIONS) {
    return DEFAULT_STATE_ACTIONS[stateType];
  }

  return "ignore";
}

/**
 * Extract mention user IDs from ProseMirror bodyData JSON.
 * Traverses the document tree looking for "mention" nodes with an `attrs.id`.
 */
function extractMentionsFromProseMirror(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const n = node as Record<string, unknown>;
  const ids: string[] = [];

  if (n.type === "mention") {
    const attrs = n.attrs as Record<string, unknown> | undefined;
    const id = attrs?.id;
    if (typeof id === "string" && id) {
      ids.push(id);
    }
  }

  const content = n.content;
  if (Array.isArray(content)) {
    for (const child of content) {
      ids.push(...extractMentionsFromProseMirror(child));
    }
  }

  return ids;
}

/**
 * Extract mentioned user identifiers from a comment.
 * Tries structured ProseMirror bodyData first (yields UUIDs), then
 * falls back to regex on the markdown body (yields usernames/handles).
 *
 * When using the regex fallback, extracted tokens may be display names
 * rather than UUIDs. The agentMapping is consulted to resolve them:
 * first as direct keys (UUID match), then by scanning agentMapping
 * for values or performing a case-insensitive match against known names
 * provided via the optional nameMapping parameter.
 */
function extractMentionedUserIds(
  body: string,
  bodyData: unknown | undefined,
  agentMapping: Record<string, string>,
): string[] {
  if (bodyData) {
    const ids = extractMentionsFromProseMirror(bodyData);
    if (ids.length > 0) return [...new Set(ids)];
  }

  const matches = body.matchAll(/@([a-zA-Z0-9_.-]+)/g);
  const rawTokens = [...new Set([...matches].map((m) => m[1]))];

  // Resolve each token: if it's a UUID key in agentMapping, use it directly.
  // Otherwise, search agentMapping for a key whose associated agentId matches
  // the token (case-insensitive), which handles the common case where the
  // regex extracts a display name that matches the agentId value.
  const resolved: string[] = [];
  for (const token of rawTokens) {
    if (agentMapping[token]) {
      // Direct UUID match
      resolved.push(token);
    } else {
      // Reverse lookup: find a UUID key whose agentId value matches the token
      const lowerToken = token.toLowerCase();
      const matchedUuid = Object.entries(agentMapping).find(
        ([, agentId]) => agentId.toLowerCase() === lowerToken,
      );
      if (matchedUuid) {
        resolved.push(matchedUuid[0]);
      } else {
        // Pass through as-is — will be logged as unmapped downstream
        resolved.push(token);
      }
    }
  }

  return resolved;
}

function resolveIssueLabel(data: Record<string, unknown>): string {
  const identifier = data.identifier as string | undefined;
  const title = data.title as string | undefined;
  const id = String(data.id ?? "unknown");

  const label = identifier ?? id;
  return title ? `${label}: ${title}` : label;
}

function handleIssueUpdate(
  event: LinearWebhookPayload,
  config: EventRouterConfig,
): RouterAction[] {
  const updatedFrom = event.updatedFrom ?? {};
  const actions: RouterAction[] = [];
  const issueId = String(event.data.id ?? "unknown");
  const issueLabel = resolveIssueLabel(event.data);
  const identifier = (event.data.identifier as string) ?? issueId;
  const issuePriority = (event.data.priority as number) ?? 0;

  // --- Assignee changes ---
  if ("assigneeId" in updatedFrom) {
    const oldAssignee = updatedFrom.assigneeId as string | null | undefined;
    const newAssignee = event.data.assigneeId as string | null | undefined;

    if (newAssignee) {
      const agentId = config.agentMapping[newAssignee];
      if (agentId) {
        actions.push({
          type: "wake",
          agentId,
          event: "issue.assigned",
          detail: `Assigned to issue ${issueLabel}`,
          issueId,
          issueLabel,
          identifier,
          issuePriority,
          linearUserId: newAssignee,
        });
      } else {
        config.logger.info(
          `Unmapped Linear user ${newAssignee} assigned to ${issueId}`,
        );
      }
    }

    if (oldAssignee && !newAssignee) {
      const agentId = config.agentMapping[oldAssignee];
      if (agentId) {
        actions.push({
          type: "notify",
          agentId,
          event: "issue.unassigned",
          detail: `Unassigned from issue ${issueLabel}`,
          issueId,
          issueLabel,
          identifier,
          issuePriority,
          linearUserId: oldAssignee,
        });
      } else {
        config.logger.info(
          `Unmapped Linear user ${oldAssignee} unassigned from ${issueId}`,
        );
      }
    }

    // Reassignment: both old and new assignee present — notify old assignee
    if (oldAssignee && newAssignee) {
      const agentId = config.agentMapping[oldAssignee];
      if (agentId) {
        actions.push({
          type: "notify",
          agentId,
          event: "issue.reassigned",
          detail: `Reassigned away from issue ${issueLabel}`,
          issueId,
          issueLabel,
          identifier,
          issuePriority,
          linearUserId: oldAssignee,
        });
      }
    }
  }

  // --- State changes (configurable per state type/name) ---
  if ("stateId" in updatedFrom) {
    const state = event.data.state as Record<string, unknown> | undefined;
    const stateType = state?.type as string | undefined;
    const stateName = state?.name as string | undefined;
    const action = resolveStateAction(config, stateType, stateName);

    if (action === "remove" || action === "add") {
      const assigneeId = event.data.assigneeId as string | undefined;
      if (assigneeId) {
        const agentId = config.agentMapping[assigneeId];
        if (agentId) {
          if (action === "remove") {
            actions.push({
              type: "notify",
              agentId,
              event: "issue.state_removed",
              detail: `Issue ${issueLabel} moved to ${stateName ?? stateType ?? "unknown"}`,
              issueId,
              issueLabel,
              identifier,
              issuePriority,
              linearUserId: assigneeId,
            });
          } else {
            actions.push({
              type: "wake",
              agentId,
              event: "issue.state_readded",
              detail: `Issue ${issueLabel} moved to ${stateName ?? stateType ?? "unknown"}`,
              issueId,
              issueLabel,
              identifier,
              issuePriority,
              linearUserId: assigneeId,
            });
          }
        }
      }
    }
  }

  // --- Priority changes ---
  if ("priority" in updatedFrom) {
    const assigneeId = event.data.assigneeId as string | undefined;
    if (assigneeId) {
      const agentId = config.agentMapping[assigneeId];
      if (agentId) {
        actions.push({
          type: "notify",
          agentId,
          event: "issue.priority_changed",
          detail: `Priority changed on issue ${issueLabel}`,
          issueId,
          issueLabel,
          identifier,
          issuePriority,
          linearUserId: assigneeId,
        });
      }
    }
  }

  return actions;
}

function handleIssueCreate(
  event: LinearWebhookPayload,
  config: EventRouterConfig,
): RouterAction[] {
  const assigneeId = event.data.assigneeId as string | undefined;
  if (!assigneeId) return [];

  const agentId = config.agentMapping[assigneeId];
  if (!agentId) {
    config.logger.info(
      `Unmapped Linear user ${assigneeId} assigned to ${String(event.data.id ?? "unknown")}`,
    );
    return [];
  }

  const issueId = String(event.data.id ?? "unknown");
  const issueLabel = resolveIssueLabel(event.data);
  const identifier = (event.data.identifier as string) ?? issueId;
  const issuePriority = (event.data.priority as number) ?? 0;

  return [
    {
      type: "wake",
      agentId,
      event: "issue.assigned",
      detail: `Assigned to issue ${issueLabel}`,
      issueId,
      issueLabel,
      identifier,
      issuePriority,
      linearUserId: assigneeId,
    },
  ];
}

function handleIssueRemove(
  event: LinearWebhookPayload,
  config: EventRouterConfig,
): RouterAction[] {
  const assigneeId = event.data.assigneeId as string | undefined;
  if (!assigneeId) return [];

  const agentId = config.agentMapping[assigneeId];
  if (!agentId) return [];

  const issueId = String(event.data.id ?? "unknown");
  const issueLabel = resolveIssueLabel(event.data);
  const identifier = (event.data.identifier as string) ?? issueId;
  const issuePriority = (event.data.priority as number) ?? 0;

  return [
    {
      type: "notify",
      agentId,
      event: "issue.removed",
      detail: `Issue ${issueLabel} removed`,
      issueId,
      issueLabel,
      identifier,
      issuePriority,
      linearUserId: assigneeId,
    },
  ];
}

function handleComment(
  event: LinearWebhookPayload,
  config: EventRouterConfig,
): RouterAction[] {
  const body = event.data.body as string | undefined;
  if (!body) {
    config.logger.info(
      `Comment ${String(event.data.id ?? "unknown")} has empty body — skipping`,
    );
    return [];
  }

  const commentId = String(event.data.id ?? "");
  const bodyData = event.data.bodyData;
  const mentionedIds = extractMentionedUserIds(body, bodyData, config.agentMapping);

  if (mentionedIds.length === 0) {
    return [];
  }

  const actions: RouterAction[] = [];

  const issueRef = event.data.issue as Record<string, unknown> | undefined;
  const issueId = String(issueRef?.id ?? event.data.issueId ?? "unknown");
  const issueLabel = issueRef
    ? resolveIssueLabel(issueRef)
    : issueId;
  const identifier = (issueRef?.identifier as string) ?? issueId;
  const issuePriority = (issueRef?.priority as number) ?? 0;

  for (const userId of mentionedIds) {
    const agentId = config.agentMapping[userId];
    if (agentId) {
      actions.push({
        type: "wake",
        agentId,
        event: "comment.mention",
        detail: `Mentioned in comment on issue ${issueLabel}\n\n> ${body}`,
        issueId,
        issueLabel,
        identifier,
        issuePriority,
        linearUserId: userId,
        commentId,
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
    // Apply event type filter
    if (
      config.eventFilter?.length &&
      !config.eventFilter.includes(event.type)
    ) {
      return [];
    }

    // Apply team filter
    const teamId = event.data.teamId as string | undefined;
    const teamObj = event.data.team as Record<string, unknown> | undefined;
    const teamKey = teamObj?.key as string | undefined;
    if (config.teamIds?.length) {
      const match = config.teamIds.some(
        (t) => t === teamId || t === teamKey,
      );
      if (!match && (teamId || teamKey)) return [];
    }

    if (event.type === "Issue") {
      if (event.action === "update") return handleIssueUpdate(event, config);
      if (event.action === "create") return handleIssueCreate(event, config);
      if (event.action === "remove") return handleIssueRemove(event, config);
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
