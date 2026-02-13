import { describe, it, expect } from "vitest";
import { makeApi, makeClient } from "./helpers.js";
import { registerCreateIssueTool } from "../create-issue.js";

describe("linear_create_issue", () => {
  it("creates an issue with resolved team", async () => {
    const { api, getTool } = makeApi();
    const client = makeClient({
      teams: async () => ({ nodes: [{ id: "team-1" }] }),
      createIssue: async () => ({
        issue: Promise.resolve({
          identifier: "ENG-1",
          url: "https://linear.app/eng-1",
          title: "Test issue",
        }),
      }),
    });
    registerCreateIssueTool(api, client);
    const tool = getTool("linear_create_issue");

    const result = await tool.execute("call-1", { title: "Test issue", teamId: "ENG" });
    const data = result.details;
    expect(data.id).toBe("ENG-1");
    expect(data.title).toBe("Test issue");
  });

  it("returns error when team not found", async () => {
    const { api, getTool } = makeApi();
    const client = makeClient();
    registerCreateIssueTool(api, client);
    const tool = getTool("linear_create_issue");

    const result = await tool.execute("call-1", { title: "Test", teamId: "NOPE" });
    const data = result.details;
    expect(data.error).toContain("not found");
  });

  it("handles API errors gracefully", async () => {
    const { api, getTool } = makeApi();
    const client = makeClient({
      teams: async () => { throw new Error("401 authentication failed"); },
    });
    registerCreateIssueTool(api, client);
    const tool = getTool("linear_create_issue");

    const result = await tool.execute("call-1", { title: "Test", teamId: "ENG" });
    const data = result.details;
    expect(data.error).toContain("authentication");
  });
});
