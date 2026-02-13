import { describe, it, expect } from "vitest";
import { makeApi, makeClient } from "./helpers.js";
import { registerUpdateIssueTool } from "../update-issue.js";

describe("linear_update_issue", () => {
  it("appends to description instead of replacing", async () => {
    const { api, getTool } = makeApi();
    const client = makeClient({
      issues: async () => ({
        nodes: [{
          id: "uuid-1",
          identifier: "ENG-1",
          description: "Original description",
          team: Promise.resolve({
            states: async () => ({ nodes: [] }),
          }),
        }],
      }),
      updateIssue: async (_id: string, input: any) => {
        // Verify append behavior
        expect(input.description).toContain("Original description");
        expect(input.description).toContain("Appended text");
        return {};
      },
    });
    registerUpdateIssueTool(api, client);
    const tool = getTool("linear_update_issue");

    const result = await tool.execute("call-1", {
      issueId: "ENG-1",
      description: "Appended text",
    });
    const data = result.details;
    expect(data.success).toBe(true);
    expect(data.updated).toContain("description (appended)");
  });

  it("returns error when issue not found", async () => {
    const { api, getTool } = makeApi();
    const client = makeClient();
    registerUpdateIssueTool(api, client);
    const tool = getTool("linear_update_issue");

    const result = await tool.execute("call-1", { issueId: "NOPE-1", state: "Done" });
    const data = result.details;
    expect(data.error).toContain("not found");
  });

  it("handles rate limit errors", async () => {
    const { api, getTool } = makeApi();
    const client = makeClient({
      issues: async () => { throw new Error("429 rate limit exceeded"); },
    });
    registerUpdateIssueTool(api, client);
    const tool = getTool("linear_update_issue");

    const result = await tool.execute("call-1", { issueId: "ENG-1", state: "Done" });
    const data = result.details;
    expect(data.error).toContain("rate limit");
  });
});
