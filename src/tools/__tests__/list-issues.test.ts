import { describe, it, expect } from "vitest";
import { makeApi, makeClient } from "./helpers.js";
import { registerListIssuesTool } from "../list-issues.js";

describe("linear_list_issues", () => {
  it("lists issues with resolved fields", async () => {
    const { api, getTool } = makeApi();
    const client = makeClient({
      issues: async () => ({
        nodes: [{
          identifier: "ENG-1",
          title: "Test issue",
          priority: 2,
          url: "https://linear.app/eng-1",
          state: Promise.resolve({ name: "In Progress" }),
          assignee: Promise.resolve({ displayName: "Alice" }),
        }],
      }),
    });
    registerListIssuesTool(api, client);
    const tool = getTool("linear_list_issues");

    const result = await tool.execute("call-1", {});
    const data = result.details;
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("ENG-1");
    expect(data[0].state).toBe("In Progress");
    expect(data[0].priority).toBe("High");
  });

  it("returns empty array when no issues match", async () => {
    const { api, getTool } = makeApi();
    const client = makeClient();
    registerListIssuesTool(api, client);
    const tool = getTool("linear_list_issues");

    const result = await tool.execute("call-1", { team: "NOPE" });
    const data = result.details;
    expect(data).toEqual([]);
  });

  it("handles API errors gracefully", async () => {
    const { api, getTool } = makeApi();
    const client = makeClient({
      issues: async () => { throw new Error("network timeout"); },
    });
    registerListIssuesTool(api, client);
    const tool = getTool("linear_list_issues");

    const result = await tool.execute("call-1", {});
    const data = result.details;
    expect(data.error).toContain("Linear API error");
  });
});
