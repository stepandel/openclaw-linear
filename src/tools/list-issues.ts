import type { LinearClient } from "@linear/sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";

const PRIORITY_LABELS: Record<number, string> = {
  0: "None",
  1: "Urgent",
  2: "High",
  3: "Normal",
  4: "Low",
};

export function registerListIssuesTool(
  api: OpenClawPluginApi,
  client: LinearClient,
): void {
  api.registerTool({
    name: "linear_list_issues",
    label: "List Linear Issues",
    description:
      "List issues from Linear with optional filters for state, assignee, team, and labels.",
    parameters: {
      type: "object",
      properties: {
        state: {
          type: "string",
          description: "Filter by workflow state name (e.g. 'In Progress', 'Done')",
        },
        assignee: {
          type: "string",
          description: "Filter by assignee display name",
        },
        team: {
          type: "string",
          description: "Filter by team key (e.g. 'ENG')",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Filter by label names",
        },
      },
    },
    async execute(_id, params) {
     try {
      const filter: Record<string, unknown> = {};

      if (params.state) {
        filter.state = { name: { eq: params.state } };
      }
      if (params.assignee) {
        filter.assignee = { displayName: { eq: params.assignee } };
      }
      if (params.team) {
        filter.team = { key: { eq: params.team } };
      }
      if (params.labels) {
        filter.labels = {
          some: { name: { in: params.labels } },
        };
      }

      const connection = await client.issues({
        first: 50,
        filter,
      });

      const issues = await Promise.all(
        connection.nodes.map(async (issue) => {
          const [state, assignee] = await Promise.all([
            issue.state,
            issue.assignee,
          ]);
          return {
            id: issue.identifier,
            title: issue.title,
            state: state?.name ?? "Unknown",
            assignee: assignee?.displayName ?? "Unassigned",
            priority: PRIORITY_LABELS[issue.priority] ?? String(issue.priority),
            url: issue.url,
          };
        }),
      );

      return jsonResult(issues);
     } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("authentication") || message.includes("401")) {
        return jsonResult({ error: "Linear authentication failed. Check your API key." });
      }
      if (message.includes("rate") || message.includes("429")) {
        return jsonResult({ error: "Linear rate limit hit. Please try again shortly." });
      }
      return jsonResult({ error: `Linear API error: ${message}` });
     }
    },
  });
}
