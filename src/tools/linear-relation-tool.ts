import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult, stringEnum, optionalStringEnum } from "openclaw/plugin-sdk/agent-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { graphql, resolveIssueId } from "../linear-api.js";

const RELATION_TYPE_MAP: Record<string, string> = {
  blocks: "blocks",
  "blocked-by": "blocks", // reversed direction
  related: "related",
  duplicate: "duplicate",
};

const Params = Type.Object({
  action: stringEnum(
    ["list", "add", "delete"] as const,
    {
      description:
        "list: show all relations for an issue. " +
        "add: create a relation between two issues. " +
        "delete: remove a relation.",
    },
  ),
  issueId: Type.Optional(
    Type.String({
      description:
        "Issue identifier (e.g. ENG-123). Required for list and add.",
    }),
  ),
  type: optionalStringEnum(
    ["blocks", "blocked-by", "related", "duplicate"] as const,
    {
      description: "Relation type. Required for add.",
    },
  ),
  relatedIssueId: Type.Optional(
    Type.String({
      description:
        "Related issue identifier (e.g. ENG-456). Required for add.",
    }),
  ),
  relationId: Type.Optional(
    Type.String({
      description: "Relation ID. Required for delete.",
    }),
  ),
});
type Params = Static<typeof Params>;

export function createRelationTool(): AnyAgentTool {
  return {
    name: "linear_relation",
    label: "Linear Relation",
    description:
      "Manage issue relations in Linear. Actions: list, add, delete.",
    parameters: Params,
    async execute(_toolCallId: string, params: Params) {
      try {
        switch (params.action) {
          case "list":
            return await listRelations(params);
          case "add":
            return await addRelation(params);
          case "delete":
            return await deleteRelation(params);
          default:
            return jsonResult({
              error: `Unknown action: ${(params as { action: string }).action}`,
            });
        }
      } catch (err) {
        return jsonResult({
          error: `linear_relation error: ${formatErrorMessage(err)}`,
        });
      }
    },
  };
}

async function listRelations(params: Params) {
  if (!params.issueId) {
    return jsonResult({ error: "issueId is required for list" });
  }

  const id = await resolveIssueId(params.issueId);

  const data = await graphql<{
    issue: {
      relations: {
        nodes: {
          id: string;
          type: string;
          relatedIssue: { identifier: string; title: string };
        }[];
      };
      inverseRelations: {
        nodes: {
          id: string;
          type: string;
          issue: { identifier: string; title: string };
        }[];
      };
    };
  }>(
    `query($id: String!) {
      issue(id: $id) {
        relations {
          nodes {
            id
            type
            relatedIssue { identifier title }
          }
        }
        inverseRelations {
          nodes {
            id
            type
            issue { identifier title }
          }
        }
      }
    }`,
    { id },
  );

  const relations = data.issue.relations.nodes.map((r) => ({
    id: r.id,
    type: r.type,
    issue: r.relatedIssue,
  }));

  const inverseRelations = data.issue.inverseRelations.nodes.map((r) => ({
    id: r.id,
    type: r.type,
    direction: "inverse",
    issue: r.issue,
  }));

  return jsonResult({
    relations: [...relations, ...inverseRelations],
  });
}

async function addRelation(params: Params) {
  if (!params.issueId) {
    return jsonResult({ error: "issueId is required for add" });
  }
  if (!params.type) {
    return jsonResult({ error: "type is required for add" });
  }
  if (!params.relatedIssueId) {
    return jsonResult({ error: "relatedIssueId is required for add" });
  }

  const apiType = RELATION_TYPE_MAP[params.type];
  if (!apiType) {
    return jsonResult({ error: `Unknown relation type: ${params.type}` });
  }

  // For "blocked-by", swap the direction: the related issue blocks this one
  let issueId: string;
  let relatedIssueId: string;

  if (params.type === "blocked-by") {
    issueId = await resolveIssueId(params.relatedIssueId);
    relatedIssueId = await resolveIssueId(params.issueId);
  } else {
    issueId = await resolveIssueId(params.issueId);
    relatedIssueId = await resolveIssueId(params.relatedIssueId);
  }

  const data = await graphql<{
    issueRelationCreate: {
      success: boolean;
      issueRelation: { id: string; type: string };
    };
  }>(
    `mutation($input: IssueRelationCreateInput!) {
      issueRelationCreate(input: $input) {
        success
        issueRelation { id type }
      }
    }`,
    {
      input: {
        issueId,
        relatedIssueId,
        type: apiType,
      },
    },
  );

  return jsonResult(data.issueRelationCreate);
}

async function deleteRelation(params: Params) {
  if (!params.relationId) {
    return jsonResult({ error: "relationId is required for delete" });
  }

  const data = await graphql<{
    issueRelationDelete: { success: boolean };
  }>(
    `mutation($id: String!) {
      issueRelationDelete(id: $id) { success }
    }`,
    { id: params.relationId },
  );

  return jsonResult({ success: data.issueRelationDelete.success });
}
