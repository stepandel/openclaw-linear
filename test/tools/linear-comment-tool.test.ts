import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LinearClient } from "../../src/linear-client.js";
import { createCommentTool } from "../../src/tools/linear-comment-tool.js";

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

describe("linear_comment tool", () => {
  let client: ReturnType<typeof mockClient>;

  beforeEach(() => {
    client = mockClient();
  });

  it("has correct name", () => {
    const tool = createCommentTool(client);
    expect(tool.name).toBe("linear_comment");
  });

  describe("list", () => {
    it("returns comments for an issue", async () => {
      vi.mocked(client.resolveIssueId).mockResolvedValue("uuid-1");
      vi.mocked(client.graphql).mockResolvedValue({
        issue: {
          comments: {
            nodes: [
              {
                id: "c1",
                body: "Hello",
                createdAt: "2025-01-01",
                updatedAt: "2025-01-01",
                user: { id: "u1", name: "Alice" },
                parent: null,
              },
            ],
          },
        },
      });

      const tool = createCommentTool(client);
      const result = await tool.execute("call-1", {
        action: "list",
        issueId: "ENG-42",
      });
      const data = parse(result);
      expect(data.comments).toHaveLength(1);
      expect(data.comments[0].body).toBe("Hello");
    });

    it("returns error without issueId", async () => {
      const tool = createCommentTool(client);
      const result = await tool.execute("call-1", { action: "list" });
      const data = parse(result);
      expect(data.error).toContain("issueId is required");
    });
  });

  describe("add", () => {
    it("creates a comment", async () => {
      vi.mocked(client.resolveIssueId).mockResolvedValue("uuid-1");
      vi.mocked(client.graphql).mockResolvedValue({
        commentCreate: {
          success: true,
          comment: { id: "c-new", body: "My comment" },
        },
      });

      const tool = createCommentTool(client);
      const result = await tool.execute("call-1", {
        action: "add",
        issueId: "ENG-42",
        body: "My comment",
      });
      const data = parse(result);
      expect(data.success).toBe(true);
    });

    it("supports threading with parentCommentId", async () => {
      vi.mocked(client.resolveIssueId).mockResolvedValue("uuid-1");
      vi.mocked(client.graphql).mockResolvedValue({
        commentCreate: {
          success: true,
          comment: { id: "c-reply", body: "Reply" },
        },
      });

      const tool = createCommentTool(client);
      await tool.execute("call-1", {
        action: "add",
        issueId: "ENG-42",
        body: "Reply",
        parentCommentId: "c1",
      });

      const call = vi.mocked(client.graphql).mock.calls[0];
      const vars = call[1] as { input: { parentId?: string } };
      expect(vars.input.parentId).toBe("c1");
    });

    it("returns error without issueId", async () => {
      const tool = createCommentTool(client);
      const result = await tool.execute("call-1", {
        action: "add",
        body: "text",
      });
      const data = parse(result);
      expect(data.error).toContain("issueId is required");
    });

    it("returns error without body", async () => {
      const tool = createCommentTool(client);
      const result = await tool.execute("call-1", {
        action: "add",
        issueId: "ENG-42",
      });
      const data = parse(result);
      expect(data.error).toContain("body is required");
    });
  });

  describe("update", () => {
    it("updates a comment", async () => {
      vi.mocked(client.graphql).mockResolvedValue({
        commentUpdate: {
          success: true,
          comment: { id: "c1", body: "Updated" },
        },
      });

      const tool = createCommentTool(client);
      const result = await tool.execute("call-1", {
        action: "update",
        commentId: "c1",
        body: "Updated",
      });
      const data = parse(result);
      expect(data.success).toBe(true);
    });

    it("returns error without commentId", async () => {
      const tool = createCommentTool(client);
      const result = await tool.execute("call-1", {
        action: "update",
        body: "text",
      });
      const data = parse(result);
      expect(data.error).toContain("commentId is required");
    });

    it("returns error without body", async () => {
      const tool = createCommentTool(client);
      const result = await tool.execute("call-1", {
        action: "update",
        commentId: "c1",
      });
      const data = parse(result);
      expect(data.error).toContain("body is required");
    });
  });

  it("catches and returns API errors", async () => {
    vi.mocked(client.resolveIssueId).mockRejectedValue(new Error("API down"));

    const tool = createCommentTool(client);
    const result = await tool.execute("call-1", {
      action: "list",
      issueId: "ENG-1",
    });
    const data = parse(result);
    expect(data.error).toContain("API down");
  });
});
