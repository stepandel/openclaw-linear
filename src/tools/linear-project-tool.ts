import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult, stringEnum } from "openclaw/plugin-sdk/agent-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { graphql, resolveTeamId } from "../linear-api.js";

const Params = Type.Object({
  action: stringEnum(
    ["list", "view", "create"] as const,
    {
      description:
        "list: search/filter projects. " +
        "view: get full project details. " +
        "create: create a new project.",
    },
  ),
  projectId: Type.Optional(
    Type.String({
      description: "Project ID. Required for view.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description: "Project name. Required for create.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description: "Project description (used with create).",
    }),
  ),
  team: Type.Optional(
    Type.String({
      description: "Team key for filtering (list) or association (create).",
    }),
  ),
  status: Type.Optional(
    Type.String({
      description:
        "Project status filter for list (e.g. planned, started, completed).",
    }),
  ),
});
type Params = Static<typeof Params>;

export function createProjectTool(): AnyAgentTool {
  return {
    name: "linear_project",
    label: "Linear Project",
    description:
      "Manage Linear projects. Actions: list, view, create.",
    parameters: Params,
    async execute(_toolCallId: string, params: Params) {
      try {
        switch (params.action) {
          case "list":
            return await listProjects(params);
          case "view":
            return await viewProject(params);
          case "create":
            return await createProject(params);
          default:
            return jsonResult({
              error: `Unknown action: ${(params as { action: string }).action}`,
            });
        }
      } catch (err) {
        return jsonResult({
          error: `linear_project error: ${formatErrorMessage(err)}`,
        });
      }
    },
  };
}

async function listProjects(params: Params) {
  const filterParts: string[] = [];
  const variables: Record<string, unknown> = {};
  const varDecls: string[] = [];

  if (params.status) {
    filterParts.push("status: { type: { eqIgnoreCase: $status } }");
    variables.status = params.status;
    varDecls.push("$status: String!");
  }

  // Team filtering for projects uses accessibleTeams
  if (params.team) {
    filterParts.push(
      "accessibleTeams: { some: { key: { eq: $team } } }",
    );
    variables.team = params.team.toUpperCase();
    varDecls.push("$team: String!");
  }

  const filterStr = filterParts.length
    ? `filter: { ${filterParts.join(", ")} }, `
    : "";
  const varStr = varDecls.length ? `(${varDecls.join(", ")})` : "";

  const data = await graphql<{
    projects: {
      nodes: {
        id: string;
        name: string;
        status: { name: string; type: string };
        teams: { nodes: { name: string; key: string }[] };
      }[];
    };
  }>(
    `query${varStr} {
      projects(${filterStr}first: 50) {
        nodes {
          id
          name
          status { name type }
          teams { nodes { name key } }
        }
      }
    }`,
    variables,
  );

  return jsonResult({ projects: data.projects.nodes });
}

async function viewProject(params: Params) {
  if (!params.projectId) {
    return jsonResult({ error: "projectId is required for view" });
  }

  const data = await graphql<{
    project: Record<string, unknown>;
  }>(
    `query($id: String!) {
      project(id: $id) {
        id
        name
        description
        status { name type }
        url
        createdAt
        updatedAt
        teams { nodes { id name key } }
        members { nodes { id name } }
      }
    }`,
    { id: params.projectId },
  );

  return jsonResult(data.project);
}

async function createProject(params: Params) {
  if (!params.name) {
    return jsonResult({ error: "name is required for create" });
  }

  const input: Record<string, unknown> = { name: params.name };

  if (params.description) input.description = params.description;
  if (params.team) {
    const teamId = await resolveTeamId(params.team);
    input.teamIds = [teamId];
  }

  const data = await graphql<{
    projectCreate: {
      success: boolean;
      project: { id: string; name: string; url: string };
    };
  }>(
    `mutation($input: ProjectCreateInput!) {
      projectCreate(input: $input) {
        success
        project { id name url }
      }
    }`,
    { input },
  );

  return jsonResult(data.projectCreate);
}
