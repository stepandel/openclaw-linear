import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LinearClient } from "../../src/linear-client.js";
import { createTeamTool } from "../../src/tools/linear-team-tool.js";

function mockClient(): LinearClient {
  return {
    graphql: vi.fn(),
    resolveIssueId: vi.fn(),
    resolveTeamId: vi.fn(),
    resolveStateId: vi.fn(),
    resolveUserId: vi.fn(),
    resolveLabelIds: vi.fn(),
    resolveProjectId: vi.fn(),
    _resetIssueIdCache: vi.fn(),
  } as unknown as LinearClient;
}

function parse(result: { content: { type: string; text?: string }[] }) {
  const text = result.content.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

describe("linear_team tool", () => {
  let client: ReturnType<typeof mockClient>;

  beforeEach(() => {
    client = mockClient();
  });

  it("has correct name", () => {
    const tool = createTeamTool(client);
    expect(tool.name).toBe("linear_team");
  });

  describe("list", () => {
    it("returns all teams", async () => {
      vi.mocked(client.graphql).mockResolvedValue({
        teams: {
          nodes: [
            { id: "t1", name: "Engineering", key: "ENG" },
            { id: "t2", name: "Operations", key: "OPS" },
          ],
        },
      });

      const tool = createTeamTool(client);
      const result = await tool.execute("call-1", { action: "list" });
      const data = parse(result);
      expect(data.teams).toHaveLength(2);
      expect(data.teams[0].key).toBe("ENG");
    });
  });

  describe("members", () => {
    it("returns members of a team", async () => {
      vi.mocked(client.graphql).mockResolvedValue({
        teams: {
          nodes: [
            {
              members: {
                nodes: [
                  { id: "u1", name: "Alice", email: "alice@test.com" },
                  { id: "u2", name: "Bob", email: "bob@test.com" },
                ],
              },
            },
          ],
        },
      });

      const tool = createTeamTool(client);
      const result = await tool.execute("call-1", {
        action: "members",
        team: "ENG",
      });
      const data = parse(result);
      expect(data.members).toHaveLength(2);
      expect(data.members[0].name).toBe("Alice");
    });

    it("returns error without team", async () => {
      const tool = createTeamTool(client);
      const result = await tool.execute("call-1", { action: "members" });
      const data = parse(result);
      expect(data.error).toContain("team is required");
    });

    it("returns error when team not found", async () => {
      vi.mocked(client.graphql).mockResolvedValue({ teams: { nodes: [] } });

      const tool = createTeamTool(client);
      const result = await tool.execute("call-1", {
        action: "members",
        team: "NOPE",
      });
      const data = parse(result);
      expect(data.error).toContain("not found");
    });
  });

  it("catches and returns API errors", async () => {
    vi.mocked(client.graphql).mockRejectedValue(new Error("Network error"));

    const tool = createTeamTool(client);
    const result = await tool.execute("call-1", { action: "list" });
    const data = parse(result);
    expect(data.error).toContain("Network error");
  });
});
