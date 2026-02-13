import type { LinearClient } from "@linear/sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";

export function registerCreateIssueTool(
  api: OpenClawPluginApi,
  client: LinearClient,
): void {
  api.registerTool({
    name: "linear_create_issue",
    label: "Create Linear Issue",
    description: "Create a new issue in Linear.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Issue title",
        },
        teamId: {
          type: "string",
          description: "Team key or ID (e.g. 'ENG')",
        },
        description: {
          type: "string",
          description: "Issue description (markdown)",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Label names to apply",
        },
        priority: {
          type: "number",
          description: "Priority: 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low",
        },
        assignee: {
          type: "string",
          description: "Assignee email address",
        },
      },
      required: ["title", "teamId"],
    },
    async execute(_id, params) {
     try {
      // Resolve team by key or ID
      const teams = await client.teams({
        filter: {
          or: [
            { key: { eq: params.teamId } },
            { id: { eq: params.teamId } },
          ],
        },
      });
      const team = teams.nodes[0];
      if (!team) {
        return jsonResult({ error: `Team "${params.teamId}" not found` });
      }

      const input: Record<string, unknown> = {
        teamId: team.id,
        title: params.title,
      };

      if (params.description) {
        input.description = params.description;
      }

      if (params.priority !== undefined) {
        input.priority = params.priority;
      }

      if (params.assignee) {
        const org = await client.organization;
        const users = await org.users();
        const match = users.nodes.find(
          (u) => u.email?.toLowerCase() === params.assignee.toLowerCase(),
        );
        if (match) {
          input.assigneeId = match.id;
        } else {
          return jsonResult({
            error: `User with email "${params.assignee}" not found`,
          });
        }
      }

      if (params.labels?.length) {
        const teamLabels = await team.labels();
        const orgLabels = await client.issueLabels();
        const allLabels = [...teamLabels.nodes, ...orgLabels.nodes];
        const labelIds: string[] = [];

        for (const name of params.labels) {
          const match = allLabels.find(
            (l) => l.name.toLowerCase() === name.toLowerCase(),
          );
          if (match) {
            labelIds.push(match.id);
          } else {
            return jsonResult({
              error: `Label "${name}" not found`,
            });
          }
        }
        input.labelIds = labelIds;
      }

      const payload = await client.createIssue(input as any);
      const issue = await payload.issue;

      return jsonResult({
        id: issue?.identifier,
        url: issue?.url,
        title: issue?.title,
      });
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
