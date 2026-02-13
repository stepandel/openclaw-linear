import { describe, it, expect } from "vitest";
import { makeApi, makeClient } from "./helpers.js";
import { registerAddCommentTool } from "../add-comment.js";

describe("linear_add_comment", () => {
  it("adds a comment to an existing issue", async () => {
    const { api, getTool } = makeApi();
    const client = makeClient({
      issues: async () => ({
        nodes: [{ id: "uuid-1", identifier: "ENG-1" }],
      }),
      createComment: async () => ({
        comment: Promise.resolve({
          id: "comment-1",
          url: "https://linear.app/comment-1",
        }),
      }),
    });
    registerAddCommentTool(api, client);
    const tool = getTool("linear_add_comment");

    const result = await tool.execute("call-1", { issueId: "ENG-1", body: "Looks good!" });
    const data = result.details;
    expect(data.success).toBe(true);
    expect(data.commentId).toBe("comment-1");
  });

  it("returns error when issue not found", async () => {
    const { api, getTool } = makeApi();
    const client = makeClient();
    registerAddCommentTool(api, client);
    const tool = getTool("linear_add_comment");

    const result = await tool.execute("call-1", { issueId: "NOPE-1", body: "Hello" });
    const data = result.details;
    expect(data.error).toContain("not found");
  });

  it("handles auth errors gracefully", async () => {
    const { api, getTool } = makeApi();
    const client = makeClient({
      issues: async () => { throw new Error("401 Unauthorized"); },
    });
    registerAddCommentTool(api, client);
    const tool = getTool("linear_add_comment");

    const result = await tool.execute("call-1", { issueId: "ENG-1", body: "Hello" });
    const data = result.details;
    expect(data.error).toContain("authentication");
  });
});
