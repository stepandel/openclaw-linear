import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult, stringEnum } from "openclaw/plugin-sdk/agent-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { graphql } from "../linear-api.js";

const Params = Type.Object({
  action: stringEnum(
    ["list", "members"] as const,
    {
      description:
        "list: get all teams. " +
        "members: get members of a specific team.",
    },
  ),
  team: Type.Optional(
    Type.String({
      description: "Team key (e.g. ENG). Required for members.",
    }),
  ),
});
type Params = Static<typeof Params>;

export function createTeamTool(): AnyAgentTool {
  return {
    name: "linear_team",
    label: "Linear Team",
    description: "View Linear teams and their members. Actions: list, members.",
    parameters: Params,
    async execute(_toolCallId: string, params: Params) {
      try {
        switch (params.action) {
          case "list":
            return await listTeams();
          case "members":
            return await listMembers(params);
          default:
            return jsonResult({
              error: `Unknown action: ${(params as { action: string }).action}`,
            });
        }
      } catch (err) {
        return jsonResult({
          error: `linear_team error: ${formatErrorMessage(err)}`,
        });
      }
    },
  };
}

async function listTeams() {
  const data = await graphql<{
    teams: {
      nodes: { id: string; name: string; key: string }[];
    };
  }>(`{ teams { nodes { id name key } } }`);

  return jsonResult({ teams: data.teams.nodes });
}

async function listMembers(params: Params) {
  if (!params.team) {
    return jsonResult({ error: "team is required for members" });
  }

  const data = await graphql<{
    teams: {
      nodes: {
        members: {
          nodes: { id: string; name: string; email: string }[];
        };
      }[];
    };
  }>(
    `query($key: String!) {
      teams(filter: { key: { eq: $key } }) {
        nodes {
          members {
            nodes { id name email }
          }
        }
      }
    }`,
    { key: params.team.toUpperCase() },
  );

  if (data.teams.nodes.length === 0) {
    return jsonResult({ error: `Team "${params.team}" not found` });
  }

  return jsonResult({ members: data.teams.nodes[0].members.nodes });
}
