import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult, stringEnum } from "openclaw/plugin-sdk/agent-runtime";
import type { InboxQueue } from "../work-queue.js";

const QueueAction = stringEnum(
  ["peek", "pop", "drain", "complete"] as const,
  {
    description:
      "peek: view all pending items without removing them. " +
      "pop: claim the highest-priority pending item. " +
      "drain: claim all pending items. " +
      "complete: finish work on an in-progress item (requires issueId).",
  },
);

const QueueToolParams = Type.Object({
  action: QueueAction,
  issueId: Type.Optional(
    Type.String({ description: "Issue ID to complete (required for 'complete' action)." }),
  ),
});

type QueueToolParams = Static<typeof QueueToolParams>;

export function createQueueTool(queue: InboxQueue): AnyAgentTool {
  return {
    name: "linear_queue",
    label: "Linear Queue",
    description:
      "Manage the Linear notification inbox queue. " +
      "Use 'peek' to see pending items, 'pop' to claim the next item, 'drain' to claim all items, " +
      "or 'complete' to finish work on a claimed item.",
    parameters: QueueToolParams,
    async execute(_toolCallId: string, params: QueueToolParams) {
      switch (params.action) {
        case "peek": {
          const items = await queue.peek();
          return jsonResult({ count: items.length, items });
        }
        case "pop": {
          const item = await queue.pop();
          return jsonResult(item ? { item } : { item: null, message: "Queue is empty" });
        }
        case "drain": {
          const items = await queue.drain();
          return jsonResult({ count: items.length, items });
        }
        case "complete": {
          if (!params.issueId) {
            return jsonResult({ error: "issueId is required for 'complete' action" });
          }
          const completed = await queue.complete(params.issueId);
          const remaining = await queue.peek();
          return jsonResult({
            completed,
            issueId: params.issueId,
            remaining: remaining.length,
          });
        }
        default:
          return jsonResult({
            error: `Unknown action: ${(params as { action: string }).action}`,
          });
      }
    },
  };
}
