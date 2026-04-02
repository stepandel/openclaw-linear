import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult, stringEnum } from "openclaw/plugin-sdk/agent-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  graphql,
  resolveIssueId,
  resolveTeamId,
  resolveStateId,
  resolveUserId,
  resolveLabelIds,
  resolveProjectId,
} from "../linear-api.js";

const Params = Type.Object({
  action: stringEnum(
    ["view", "list", "create", "update", "delete"] as const,
    {
      description:
        "view: get full issue details. " +
        "list: search/filter issues. " +
        "create: create a new issue. " +
        "update: modify an existing issue. " +
        "delete: delete an issue.",
    },
  ),
  issueId: Type.Optional(
    Type.String({
      description:
        "Issue identifier (e.g. ENG-123). Required for view, update, delete.",
    }),
  ),
  title: Type.Optional(
    Type.String({ description: "Issue title (required for create)." }),
  ),
  description: Type.Optional(
    Type.String({ description: "Issue description (markdown)." }),
  ),
  appendDescription: Type.Optional(
    Type.Boolean({
      description:
        "When true, append the description text to the existing description instead of replacing it. Only used with update.",
    }),
  ),
  assignee: Type.Optional(
    Type.String({ description: "Assignee display name or email." }),
  ),
  state: Type.Optional(
    Type.String({
      description: "Workflow state name (e.g. In Progress, Done).",
    }),
  ),
  priority: Type.Optional(
    Type.Number({
      description: "Priority (0=None, 1=Urgent, 2=High, 3=Medium, 4=Low).",
    }),
  ),
  team: Type.Optional(
    Type.String({
      description:
        "Team key (e.g. ENG). Required for create if you belong to multiple teams. Used as filter for list.",
    }),
  ),
  project: Type.Optional(
    Type.String({ description: "Project name." }),
  ),
  parent: Type.Optional(
    Type.String({
      description:
        "Parent issue identifier for sub-issues (e.g. ENG-100). Used with create.",
    }),
  ),
  labels: Type.Optional(
    Type.Array(Type.String(), { description: "Label names." }),
  ),
  dueDate: Type.Optional(
    Type.String({
      description:
        "Due date in YYYY-MM-DD format (e.g. 2025-12-31). Pass null or empty string to clear.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Max results for list (default 50).",
    }),
  ),
});
type Params = Static<typeof Params>;

export function createIssueTool(): AnyAgentTool {
  return {
    name: "linear_issue",
    label: "Linear Issue",
    description:
      "Manage Linear issues. Actions: view, list, create, update, delete.",
    parameters: Params,
    async execute(_toolCallId: string, params: Params) {
      try {
        switch (params.action) {
          case "view":
            return await viewIssue(params);
          case "list":
            return await listIssues(params);
          case "create":
            return await createIssue(params);
          case "update":
            return await updateIssue(params);
          case "delete":
            return await deleteIssue(params);
          default:
            return jsonResult({
              error: `Unknown action: ${(params as { action: string }).action}`,
            });
        }
      } catch (err) {
        return jsonResult({
          error: `linear_issue error: ${formatErrorMessage(err)}`,
        });
      }
    },
  };
}

async function viewIssue(params: Params) {
  if (!params.issueId) {
    return jsonResult({ error: "issueId is required for view" });
  }

  const id = await resolveIssueId(params.issueId);

  const data = await graphql<{ issue: Record<string, unknown> }>(
    `query($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        description
        url
        priority
        priorityLabel
        estimate
        dueDate
        createdAt
        updatedAt
        state { id name type }
        assignee { id name email }
        team { id name key }
        project { id name }
        parent { id identifier title }
        labels { nodes { id name } }
        children { nodes { id identifier title state { name } } }
      }
    }`,
    { id },
  );

  return jsonResult(data.issue);
}

async function listIssues(params: Params) {
  const filterParts: string[] = [];
  const variables: Record<string, unknown> = {};

  if (params.state) {
    filterParts.push("state: { name: { eqIgnoreCase: $state } }");
    variables.state = params.state;
  }
  if (params.assignee) {
    filterParts.push(
      "assignee: { or: [{ name: { eqIgnoreCase: $assignee } }, { email: { eq: $assignee } }] }",
    );
    variables.assignee = params.assignee;
  }
  if (params.team) {
    filterParts.push("team: { key: { eq: $team } }");
    variables.team = params.team.toUpperCase();
  }
  if (params.project) {
    filterParts.push("project: { name: { eqIgnoreCase: $project } }");
    variables.project = params.project;
  }

  const limit = params.limit ?? 50;
  variables.first = limit;

  const filterStr = filterParts.length
    ? `filter: { ${filterParts.join(", ")} }, `
    : "";

  // Build variable declarations
  const varDecls: string[] = ["$first: Int!"];
  if (params.state) varDecls.push("$state: String!");
  if (params.assignee) varDecls.push("$assignee: String!");
  if (params.team) varDecls.push("$team: String!");
  if (params.project) varDecls.push("$project: String!");

  const data = await graphql<{
    issues: {
      nodes: Record<string, unknown>[];
    };
  }>(
    `query(${varDecls.join(", ")}) {
      issues(${filterStr}first: $first) {
        nodes {
          id
          identifier
          title
          priority
          priorityLabel
          state { name type }
          assignee { name }
          team { key }
          project { name }
          labels { nodes { name } }
          dueDate
          updatedAt
        }
      }
    }`,
    variables,
  );

  return jsonResult({ issues: data.issues.nodes });
}

async function createIssue(params: Params) {
  if (!params.title) {
    return jsonResult({ error: "title is required for create" });
  }

  const input: Record<string, unknown> = { title: params.title };

  if (params.team) {
    input.teamId = await resolveTeamId(params.team);
  } else {
    // Need a team — fetch the first one
    const teams = await graphql<{
      teams: { nodes: { id: string }[] };
    }>(`{ teams(first: 1) { nodes { id } } }`);
    if (teams.teams.nodes.length === 0) {
      return jsonResult({ error: "No teams found" });
    }
    input.teamId = teams.teams.nodes[0].id;
  }

  if (params.description) input.description = params.description;
  if (params.priority !== undefined) input.priority = params.priority;

  if (params.state) {
    input.stateId = await resolveStateId(input.teamId as string, params.state);
  }
  if (params.assignee) {
    input.assigneeId = await resolveUserId(params.assignee);
  }
  if (params.project) {
    input.projectId = await resolveProjectId(params.project);
  }
  if (params.parent) {
    input.parentId = await resolveIssueId(params.parent);
  }
  if (params.labels?.length) {
    input.labelIds = await resolveLabelIds(
      input.teamId as string,
      params.labels,
    );
  }
  if (params.dueDate !== undefined) input.dueDate = params.dueDate || null;

  const data = await graphql<{
    issueCreate: {
      success: boolean;
      issue: { id: string; identifier: string; url: string; title: string };
    };
  }>(
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url title }
      }
    }`,
    { input },
  );

  return jsonResult(data.issueCreate);
}

async function updateIssue(params: Params) {
  if (!params.issueId) {
    return jsonResult({ error: "issueId is required for update" });
  }

  const id = await resolveIssueId(params.issueId);
  const input: Record<string, unknown> = {};

  // We need the team ID for state/label resolution, or the current description for append
  let teamId: string | undefined;
  if (params.state || params.labels?.length || params.appendDescription) {
    const issueData = await graphql<{
      issue: { team: { id: string }; description?: string };
    }>(
      `query($id: String!) { issue(id: $id) { team { id } description } }`,
      { id },
    );
    teamId = issueData.issue.team.id;

    if (params.appendDescription && params.description !== undefined) {
      const existing = issueData.issue.description ?? "";
      input.description = existing ? `${existing}\n\n${params.description}` : params.description;
    }
  }

  if (params.title) input.title = params.title;
  if (params.description !== undefined && !params.appendDescription) input.description = params.description;
  if (params.priority !== undefined) input.priority = params.priority;
  if (params.state) input.stateId = await resolveStateId(teamId!, params.state);
  if (params.assignee) input.assigneeId = await resolveUserId(params.assignee);
  if (params.project) input.projectId = await resolveProjectId(params.project);
  if (params.labels?.length) {
    input.labelIds = await resolveLabelIds(teamId!, params.labels);
  }
  if (params.dueDate !== undefined) input.dueDate = params.dueDate || null;

  const data = await graphql<{
    issueUpdate: {
      success: boolean;
      issue: { id: string; identifier: string; title: string };
    };
  }>(
    `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue { id identifier title }
      }
    }`,
    { id, input },
  );

  return jsonResult(data.issueUpdate);
}

async function deleteIssue(params: Params) {
  if (!params.issueId) {
    return jsonResult({ error: "issueId is required for delete" });
  }

  const id = await resolveIssueId(params.issueId);

  const data = await graphql<{
    issueDelete: { success: boolean };
  }>(
    `mutation($id: String!) {
      issueDelete(id: $id) { success }
    }`,
    { id },
  );

  return jsonResult({ success: data.issueDelete.success, issueId: params.issueId });
}
