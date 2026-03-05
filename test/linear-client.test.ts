import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LinearClient } from "../src/linear-client.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockGraphqlResponse(data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ data }),
  });
}

function mockGraphqlError(message: string) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ errors: [{ message }] }),
  });
}

describe("LinearClient", () => {
  describe("graphql", () => {
    it("sends correct headers and body", async () => {
      const client = new LinearClient("lin_api_test123");
      mockGraphqlResponse({ viewer: { id: "u1" } });

      await client.graphql("{ viewer { id } }");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.linear.app/graphql",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "lin_api_test123",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: "{ viewer { id } }" }),
        }),
      );
    });

    it("returns data on success", async () => {
      const client = new LinearClient("lin_api_test");
      mockGraphqlResponse({ viewer: { id: "u1", name: "Test" } });

      const result = await client.graphql<{ viewer: { id: string; name: string } }>(
        "{ viewer { id name } }",
      );
      expect(result.viewer).toEqual({ id: "u1", name: "Test" });
    });

    it("passes variables", async () => {
      const client = new LinearClient("lin_api_test");
      mockGraphqlResponse({ issue: { id: "i1" } });

      await client.graphql("query($id: String!) { issue(id: $id) { id } }", {
        id: "i1",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.variables).toEqual({ id: "i1" });
    });

    it("throws on HTTP error", async () => {
      const client = new LinearClient("lin_api_test");
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => '{"error":"Invalid API key"}',
      });

      await expect(client.graphql("{ viewer { id } }")).rejects.toThrow(
        'HTTP 401: Unauthorized: {"error":"Invalid API key"}',
      );
    });

    it("throws on GraphQL error", async () => {
      const client = new LinearClient("lin_api_test");
      mockGraphqlError("Entity not found");

      await expect(client.graphql("{ issue(id: \"bad\") { id } }")).rejects.toThrow(
        "Entity not found",
      );
    });
  });

  describe("resolveIssueId", () => {
    it("resolves a valid identifier", async () => {
      const client = new LinearClient("lin_api_test");
      mockGraphqlResponse({
        issues: { nodes: [{ id: "uuid-123" }] },
      });

      const id = await client.resolveIssueId("ENG-42");
      expect(id).toBe("uuid-123");
    });

    it("caches resolved IDs", async () => {
      const client = new LinearClient("lin_api_test");
      mockGraphqlResponse({
        issues: { nodes: [{ id: "uuid-123" }] },
      });

      await client.resolveIssueId("ENG-42");
      const id2 = await client.resolveIssueId("ENG-42");
      expect(id2).toBe("uuid-123");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("has independent cache per instance", async () => {
      const client1 = new LinearClient("key1");
      const client2 = new LinearClient("key2");

      mockGraphqlResponse({ issues: { nodes: [{ id: "uuid-1" }] } });
      mockGraphqlResponse({ issues: { nodes: [{ id: "uuid-2" }] } });

      await client1.resolveIssueId("ENG-42");
      await client2.resolveIssueId("ENG-42");

      expect(mockFetch).toHaveBeenCalledTimes(2); // Not shared
    });

    it("throws on invalid format", async () => {
      const client = new LinearClient("lin_api_test");
      await expect(client.resolveIssueId("bad-format-123")).rejects.toThrow(
        "Invalid issue identifier format",
      );
    });

    it("throws when issue not found", async () => {
      const client = new LinearClient("lin_api_test");
      mockGraphqlResponse({ issues: { nodes: [] } });
      await expect(client.resolveIssueId("ENG-999")).rejects.toThrow(
        "Issue ENG-999 not found",
      );
    });
  });

  describe("resolveTeamId", () => {
    it("resolves team by key", async () => {
      const client = new LinearClient("lin_api_test");
      mockGraphqlResponse({ teams: { nodes: [{ id: "team-1" }] } });
      const id = await client.resolveTeamId("ENG");
      expect(id).toBe("team-1");
    });

    it("throws when team not found", async () => {
      const client = new LinearClient("lin_api_test");
      mockGraphqlResponse({ teams: { nodes: [] } });
      await expect(client.resolveTeamId("NOPE")).rejects.toThrow('Team with key "NOPE" not found');
    });
  });

  describe("resolveStateId", () => {
    it("resolves state by name and team", async () => {
      const client = new LinearClient("lin_api_test");
      mockGraphqlResponse({
        team: {
          states: {
            nodes: [
              { id: "state-1", name: "In Progress" },
              { id: "state-2", name: "Done" },
            ],
          },
        },
      });
      const id = await client.resolveStateId("team-1", "In Progress");
      expect(id).toBe("state-1");
    });

    it("is case-insensitive", async () => {
      const client = new LinearClient("lin_api_test");
      mockGraphqlResponse({
        team: {
          states: { nodes: [{ id: "state-1", name: "In Progress" }] },
        },
      });
      const id = await client.resolveStateId("team-1", "in progress");
      expect(id).toBe("state-1");
    });

    it("throws when state not found", async () => {
      const client = new LinearClient("lin_api_test");
      mockGraphqlResponse({
        team: {
          states: {
            nodes: [
              { id: "state-1", name: "Todo" },
              { id: "state-2", name: "Done" },
            ],
          },
        },
      });
      await expect(client.resolveStateId("team-1", "Nonexistent")).rejects.toThrow(
        'Workflow state "Nonexistent" not found. Available states: Todo, Done',
      );
    });
  });

  describe("resolveUserId", () => {
    it("resolves user by name or email", async () => {
      const client = new LinearClient("lin_api_test");
      mockGraphqlResponse({ users: { nodes: [{ id: "user-1" }] } });
      const id = await client.resolveUserId("Alice");
      expect(id).toBe("user-1");
    });

    it("throws when user not found", async () => {
      const client = new LinearClient("lin_api_test");
      mockGraphqlResponse({ users: { nodes: [] } });
      await expect(client.resolveUserId("nobody")).rejects.toThrow('User "nobody" not found');
    });
  });

  describe("resolveLabelIds", () => {
    it("resolves label names to IDs", async () => {
      const client = new LinearClient("lin_api_test");
      mockGraphqlResponse({
        team: {
          labels: {
            nodes: [
              { id: "l1", name: "Bug" },
              { id: "l2", name: "Feature" },
            ],
          },
        },
      });
      const ids = await client.resolveLabelIds("team-1", ["Bug", "Feature"]);
      expect(ids).toEqual(["l1", "l2"]);
    });

    it("throws when label not found", async () => {
      const client = new LinearClient("lin_api_test");
      mockGraphqlResponse({
        team: { labels: { nodes: [{ id: "l1", name: "Bug" }] } },
      });
      await expect(client.resolveLabelIds("team-1", ["Missing"])).rejects.toThrow(
        'Label "Missing" not found in team',
      );
    });
  });

  describe("resolveProjectId", () => {
    it("resolves project by name", async () => {
      const client = new LinearClient("lin_api_test");
      mockGraphqlResponse({
        projects: { nodes: [{ id: "proj-1", name: "Alpha" }] },
      });
      const id = await client.resolveProjectId("Alpha");
      expect(id).toBe("proj-1");
    });

    it("throws when project not found", async () => {
      const client = new LinearClient("lin_api_test");
      mockGraphqlResponse({ projects: { nodes: [] } });
      await expect(client.resolveProjectId("Nonexistent")).rejects.toThrow(
        'Project "Nonexistent" not found',
      );
    });
  });
});
