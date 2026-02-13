import type { LinearClient } from "@linear/sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";

export function registerUpdateIssueTool(
  api: OpenClawPluginApi,
  client: LinearClient,
): void {
  api.registerTool({
    name: "linear_update_issue",
    label: "Update Linear Issue",
    description:
      "Update an existing Linear issue. You can change state, assignee, priority, or description.",
    parameters: {
      type: "object",
      properties: {
        issueId: {
          type: "string",
          description: "The issue identifier (e.g. 'ENG-123')",
        },
        state: {
          type: "string",
          description: "New workflow state name (e.g. 'In Progress', 'Done')",
        },
        assignee: {
          type: "string",
          description: "New assignee email address",
        },
        priority: {
          type: "number",
          description: "Priority: 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low",
        },
        description: {
          type: "string",
          description: "New issue description (markdown)",
        },
      },
      required: ["issueId"],
    },
    async execute(_id, params) {
      const issues = await client.issues({
        filter: { id: { eq: params.issueId } },
      });
      let issue = issues.nodes[0] as any;

      // Fall back to searching by identifier if not found by UUID
      if (!issue) {
        const byIdentifier = await client.searchIssues(params.issueId);
        issue = byIdentifier.nodes[0] as any;
      }

      if (!issue) {
        return jsonResult({ error: `Issue ${params.issueId} not found` });
      }

      const input: Record<string, unknown> = {};
      const updatedFields: string[] = [];

      if (params.state) {
        const team = await issue.team;
        if (team) {
          const states = await team.states();
          const match = states.nodes.find(
            (s: any) => s.name.toLowerCase() === params.state.toLowerCase(),
          );
          if (match) {
            input.stateId = match.id;
            updatedFields.push(`state → ${match.name}`);
          } else {
            return jsonResult({
              error: `State "${params.state}" not found. Available: ${states.nodes.map((s: any) => s.name).join(", ")}`,
            });
          }
        }
      }

      if (params.assignee) {
        const org = await client.organization;
        const users = await org.users();
        const match = users.nodes.find(
          (u) => u.email?.toLowerCase() === params.assignee.toLowerCase(),
        );
        if (match) {
          input.assigneeId = match.id;
          updatedFields.push(`assignee → ${match.displayName}`);
        } else {
          return jsonResult({
            error: `User with email "${params.assignee}" not found`,
          });
        }
      }

      if (params.priority !== undefined) {
        input.priority = params.priority;
        updatedFields.push(`priority → ${params.priority}`);
      }

      if (params.description) {
        input.description = params.description;
        updatedFields.push("description");
      }

      if (updatedFields.length === 0) {
        return jsonResult({ error: "No fields to update" });
      }

      await client.updateIssue(issue.id, input);

      return jsonResult({
        success: true,
        issueId: issue.identifier,
        updated: updatedFields,
      });
    },
  });
}
