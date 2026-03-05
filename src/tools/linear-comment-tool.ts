import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult, stringEnum, formatErrorMessage } from "openclaw/plugin-sdk";
import type { LinearClient } from "../linear-client.js";

const Params = Type.Object({
  action: stringEnum(
    ["list", "add", "update"] as const,
    {
      description:
        "list: get all comments on an issue. " +
        "add: post a new comment. " +
        "update: edit an existing comment.",
    },
  ),
  issueId: Type.Optional(
    Type.String({
      description:
        "Issue identifier (e.g. ENG-123). Required for list and add.",
    }),
  ),
  commentId: Type.Optional(
    Type.String({
      description: "Comment ID. Required for update.",
    }),
  ),
  body: Type.Optional(
    Type.String({
      description: "Comment body (markdown). Required for add and update.",
    }),
  ),
  parentCommentId: Type.Optional(
    Type.String({
      description: "Parent comment ID for threading a reply (used with add).",
    }),
  ),
});
type Params = Static<typeof Params>;

export function createCommentTool(client: LinearClient): AnyAgentTool {
  return {
    name: "linear_comment",
    label: "Linear Comment",
    description:
      "Manage comments on Linear issues. Actions: list, add, update.",
    parameters: Params,
    async execute(_toolCallId: string, params: Params) {
      try {
        switch (params.action) {
          case "list":
            return await listComments(client, params);
          case "add":
            return await addComment(client, params);
          case "update":
            return await updateComment(client, params);
          default:
            return jsonResult({
              error: `Unknown action: ${(params as { action: string }).action}`,
            });
        }
      } catch (err) {
        return jsonResult({
          error: `linear_comment error: ${formatErrorMessage(err)}`,
        });
      }
    },
  };
}

async function listComments(client: LinearClient, params: Params) {
  if (!params.issueId) {
    return jsonResult({ error: "issueId is required for list" });
  }

  const id = await client.resolveIssueId(params.issueId);

  const data = await client.graphql<{
    issue: {
      comments: {
        nodes: {
          id: string;
          body: string;
          createdAt: string;
          updatedAt: string;
          user: { id: string; name: string } | null;
          parent: { id: string } | null;
        }[];
      };
    };
  }>(
    `query($id: String!) {
      issue(id: $id) {
        comments(first: 100) {
          nodes {
            id
            body
            createdAt
            updatedAt
            user { id name }
            parent { id }
          }
        }
      }
    }`,
    { id },
  );

  return jsonResult({ comments: data.issue.comments.nodes });
}

async function addComment(client: LinearClient, params: Params) {
  if (!params.issueId) {
    return jsonResult({ error: "issueId is required for add" });
  }
  if (!params.body) {
    return jsonResult({ error: "body is required for add" });
  }

  const issueId = await client.resolveIssueId(params.issueId);

  const input: Record<string, unknown> = {
    issueId,
    body: params.body,
  };
  if (params.parentCommentId) {
    input.parentId = params.parentCommentId;
  }

  const data = await client.graphql<{
    commentCreate: {
      success: boolean;
      comment: { id: string; body: string };
    };
  }>(
    `mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
        comment { id body }
      }
    }`,
    { input },
  );

  return jsonResult(data.commentCreate);
}

async function updateComment(client: LinearClient, params: Params) {
  if (!params.commentId) {
    return jsonResult({ error: "commentId is required for update" });
  }
  if (!params.body) {
    return jsonResult({ error: "body is required for update" });
  }

  const data = await client.graphql<{
    commentUpdate: {
      success: boolean;
      comment: { id: string; body: string };
    };
  }>(
    `mutation($id: String!, $input: CommentUpdateInput!) {
      commentUpdate(id: $id, input: $input) {
        success
        comment { id body }
      }
    }`,
    { id: params.commentId, input: { body: params.body } },
  );

  return jsonResult(data.commentUpdate);
}
