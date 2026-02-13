import type { LinearClient } from "@linear/sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";

export function registerAddCommentTool(
  api: OpenClawPluginApi,
  client: LinearClient,
): void {
  api.registerTool({
    name: "linear_add_comment",
    label: "Add Linear Comment",
    description: "Add a comment to an existing Linear issue.",
    parameters: {
      type: "object",
      properties: {
        issueId: {
          type: "string",
          description: "The issue identifier (e.g. 'ENG-123')",
        },
        body: {
          type: "string",
          description: "Comment body (markdown)",
        },
      },
      required: ["issueId", "body"],
    },
    async execute(_id, params) {
     try {
      const issues = await client.issues({
        filter: { id: { eq: params.issueId } },
      });
      let issue = issues.nodes[0] as { id: string; identifier: string } | undefined;

      if (!issue) {
        const byIdentifier = await client.searchIssues(params.issueId);
        issue = byIdentifier.nodes[0] as { id: string; identifier: string } | undefined;
      }

      if (!issue) {
        return jsonResult({ error: `Issue ${params.issueId} not found` });
      }

      const payload = await client.createComment({
        issueId: issue.id,
        body: params.body,
      });
      const comment = await payload.comment;

      return jsonResult({
        success: true,
        issueId: issue.identifier,
        commentId: comment?.id,
        url: comment?.url,
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
