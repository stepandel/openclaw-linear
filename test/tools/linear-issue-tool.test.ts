import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LinearClient } from "../../src/linear-client.js";
import { createIssueTool } from "../../src/tools/linear-issue-tool.js";

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

describe("linear_issue tool", () => {
  let client: ReturnType<typeof mockClient>;

  beforeEach(() => {
    client = mockClient();
  });

  it("has correct name", () => {
    const tool = createIssueTool(client);
    expect(tool.name).toBe("linear_issue");
  });

  describe("view", () => {
    it("returns issue details", async () => {
      vi.mocked(client.resolveIssueId).mockResolvedValue("uuid-1");
      const issue = {
        id: "uuid-1",
        identifier: "ENG-42",
        title: "Fix bug",
        state: { name: "Todo" },
      };
      vi.mocked(client.graphql).mockResolvedValue({ issue });

      const tool = createIssueTool(client);
      const result = await tool.execute("call-1", {
        action: "view",
        issueId: "ENG-42",
      });
      const data = parse(result);
      expect(data.identifier).toBe("ENG-42");
      expect(data.title).toBe("Fix bug");
    });

    it("returns error without issueId", async () => {
      const tool = createIssueTool(client);
      const result = await tool.execute("call-1", { action: "view" });
      const data = parse(result);
      expect(data.error).toContain("issueId is required");
    });
  });

  describe("list", () => {
    it("returns filtered issues", async () => {
      vi.mocked(client.graphql).mockResolvedValue({
        issues: {
          nodes: [
            { id: "i1", identifier: "ENG-1", title: "Task 1" },
            { id: "i2", identifier: "ENG-2", title: "Task 2" },
          ],
        },
      });

      const tool = createIssueTool(client);
      const result = await tool.execute("call-1", {
        action: "list",
        state: "In Progress",
        team: "ENG",
      });
      const data = parse(result);
      expect(data.issues).toHaveLength(2);
    });

    it("lists without filters", async () => {
      vi.mocked(client.graphql).mockResolvedValue({
        issues: { nodes: [] },
      });

      const tool = createIssueTool(client);
      const result = await tool.execute("call-1", { action: "list" });
      const data = parse(result);
      expect(data.issues).toEqual([]);
    });
  });

  describe("create", () => {
    it("creates an issue with all fields", async () => {
      vi.mocked(client.resolveTeamId).mockResolvedValue("team-1");
      vi.mocked(client.resolveStateId).mockResolvedValue("state-1");
      vi.mocked(client.resolveUserId).mockResolvedValue("user-1");
      vi.mocked(client.resolveProjectId).mockResolvedValue("proj-1");
      vi.mocked(client.resolveIssueId).mockResolvedValue("parent-uuid");
      vi.mocked(client.resolveLabelIds).mockResolvedValue(["label-1"]);
      vi.mocked(client.graphql).mockResolvedValue({
        issueCreate: {
          success: true,
          issue: {
            id: "new-id",
            identifier: "ENG-100",
            url: "https://linear.app/eng/issue/ENG-100",
            title: "New issue",
          },
        },
      });

      const tool = createIssueTool(client);
      const result = await tool.execute("call-1", {
        action: "create",
        title: "New issue",
        description: "Details",
        team: "ENG",
        state: "Todo",
        assignee: "Alice",
        project: "Alpha",
        parent: "ENG-50",
        labels: ["Bug"],
        priority: 2,
      });
      const data = parse(result);
      expect(data.success).toBe(true);
      expect(data.issue.identifier).toBe("ENG-100");
    });

    it("returns error without title", async () => {
      const tool = createIssueTool(client);
      const result = await tool.execute("call-1", { action: "create" });
      const data = parse(result);
      expect(data.error).toContain("title is required");
    });

    it("fetches default team when none specified", async () => {
      vi.mocked(client.graphql)
        .mockResolvedValueOnce({ teams: { nodes: [{ id: "default-team" }] } })
        .mockResolvedValueOnce({
          issueCreate: {
            success: true,
            issue: { id: "x", identifier: "T-1", url: "u", title: "T" },
          },
        });

      const tool = createIssueTool(client);
      const result = await tool.execute("call-1", {
        action: "create",
        title: "Minimal",
      });
      const data = parse(result);
      expect(data.success).toBe(true);
    });
  });

  describe("update", () => {
    it("updates issue fields", async () => {
      vi.mocked(client.resolveIssueId).mockResolvedValue("uuid-1");
      vi.mocked(client.graphql)
        .mockResolvedValueOnce({ issue: { team: { id: "team-1" } } })
        .mockResolvedValueOnce({
          issueUpdate: {
            success: true,
            issue: { id: "uuid-1", identifier: "ENG-42", title: "Updated" },
          },
        });
      vi.mocked(client.resolveStateId).mockResolvedValue("state-done");

      const tool = createIssueTool(client);
      const result = await tool.execute("call-1", {
        action: "update",
        issueId: "ENG-42",
        state: "Done",
        title: "Updated",
      });
      const data = parse(result);
      expect(data.success).toBe(true);
    });

    it("returns error without issueId", async () => {
      const tool = createIssueTool(client);
      const result = await tool.execute("call-1", {
        action: "update",
        title: "No ID",
      });
      const data = parse(result);
      expect(data.error).toContain("issueId is required");
    });
  });

  describe("delete", () => {
    it("deletes an issue", async () => {
      vi.mocked(client.resolveIssueId).mockResolvedValue("uuid-1");
      vi.mocked(client.graphql).mockResolvedValue({
        issueDelete: { success: true },
      });

      const tool = createIssueTool(client);
      const result = await tool.execute("call-1", {
        action: "delete",
        issueId: "ENG-42",
      });
      const data = parse(result);
      expect(data.success).toBe(true);
    });

    it("returns error without issueId", async () => {
      const tool = createIssueTool(client);
      const result = await tool.execute("call-1", { action: "delete" });
      const data = parse(result);
      expect(data.error).toContain("issueId is required");
    });
  });

  it("catches and returns errors from the API", async () => {
    vi.mocked(client.resolveIssueId).mockRejectedValue(new Error("Network failure"));

    const tool = createIssueTool(client);
    const result = await tool.execute("call-1", {
      action: "view",
      issueId: "ENG-1",
    });
    const data = parse(result);
    expect(data.error).toContain("Network failure");
  });
});
