import { describe, it, expect, vi } from "vitest";
import { createEventRouter } from "./event-router.js";
import type { LinearWebhookPayload } from "./webhook-handler.js";
import type { EventRouterConfig } from "./event-router.js";

function makeConfig(
  userMap: Record<string, string> = { "user-1": "agent-1", "user-2": "agent-2" },
): EventRouterConfig {
  return {
    userMap,
    logger: { info: vi.fn(), error: vi.fn() },
  };
}

describe("event-router", () => {
  describe("assignment changes", () => {
    it("routes new assignment as wake event", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-123",
          changes: { assigneeId: { to: "user-1" } },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toEqual([
        {
          type: "wake",
          agentId: "agent-1",
          event: "issue.assigned",
          detail: "Assigned to issue issue-123",
        },
      ]);
    });

    it("routes unassignment as notify event", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-456",
          changes: { assigneeId: { from: "user-2" } },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toEqual([
        {
          type: "notify",
          agentId: "agent-2",
          event: "issue.unassigned",
          detail: "Unassigned from issue issue-456",
        },
      ]);
    });
  });

  describe("comment mentions", () => {
    it("routes @mention in comment as wake event", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          body: "Hey @user-1 can you look at this?",
          issue: { id: "issue-789" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toEqual([
        {
          type: "wake",
          agentId: "agent-1",
          event: "comment.mention",
          detail: "Mentioned in comment on issue issue-789",
        },
      ]);
    });

    it("routes multiple mentions to multiple agents", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "update",
        data: {
          body: "cc @user-1 @user-2",
          issue: { id: "issue-100" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(2);
      expect(actions[0].agentId).toBe("agent-1");
      expect(actions[1].agentId).toBe("agent-2");
    });
  });

  describe("unmapped users", () => {
    it("logs unmapped user on assignment and returns no actions", () => {
      const config = makeConfig({});
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-999",
          changes: { assigneeId: { to: "unknown-user" } },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toEqual([]);
      expect(config.logger.info).toHaveBeenCalledWith(
        "Unmapped Linear user unknown-user assigned to issue-999",
      );
    });

    it("logs unmapped user on comment mention and returns no actions", () => {
      const config = makeConfig({});
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          body: "Hey @unknown-user check this",
          issue: { id: "issue-500" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toEqual([]);
      expect(config.logger.info).toHaveBeenCalledWith(
        "Unmapped Linear user unknown-user mentioned in comment on issue-500",
      );
    });
  });

  describe("unrelated events", () => {
    it("returns empty for non-issue non-comment events", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Project",
        action: "create",
        data: { id: "proj-1" },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
    });

    it("returns empty for issue create (not update)", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "create",
        data: { id: "issue-1" },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
    });
  });
});
