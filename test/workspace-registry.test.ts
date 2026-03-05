import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { WorkspaceRegistry, type WorkspaceConfig } from "../src/workspace-registry.js";

function makeLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function makeWorkspaceConfig(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    id: "ws-1",
    apiKey: "lin_api_ws1",
    webhookSecret: "secret-ws1",
    agentMapping: { "user-uuid-1": "agent-1" },
    ...overrides,
  };
}

describe("WorkspaceRegistry", () => {
  let registry: WorkspaceRegistry;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    registry = new WorkspaceRegistry();
    logger = makeLogger();
  });

  describe("register and get", () => {
    it("registers and retrieves a workspace by id", () => {
      const config = makeWorkspaceConfig();
      registry.register(config, logger);

      const ws = registry.get("ws-1");
      expect(ws).toBeDefined();
      expect(ws!.config.id).toBe("ws-1");
      expect(ws!.client).toBeDefined();
      expect(ws!.routeEvent).toBeTypeOf("function");
    });

    it("returns undefined for unknown id", () => {
      expect(registry.get("unknown")).toBeUndefined();
    });

    it("reports correct size", () => {
      expect(registry.size).toBe(0);
      registry.register(makeWorkspaceConfig({ id: "a" }), logger);
      expect(registry.size).toBe(1);
      registry.register(makeWorkspaceConfig({ id: "b" }), logger);
      expect(registry.size).toBe(2);
    });
  });

  describe("getDefault", () => {
    it("returns the first registered workspace", () => {
      registry.register(makeWorkspaceConfig({ id: "first" }), logger);
      registry.register(makeWorkspaceConfig({ id: "second" }), logger);

      const ws = registry.getDefault();
      expect(ws).toBeDefined();
      expect(ws!.config.id).toBe("first");
    });

    it("returns undefined when empty", () => {
      expect(registry.getDefault()).toBeUndefined();
    });
  });

  describe("all", () => {
    it("returns all registered workspaces", () => {
      registry.register(makeWorkspaceConfig({ id: "a" }), logger);
      registry.register(makeWorkspaceConfig({ id: "b" }), logger);

      const all = registry.all();
      expect(all).toHaveLength(2);
      expect(all.map((w) => w.config.id)).toEqual(["a", "b"]);
    });
  });

  describe("matchBySignature", () => {
    it("matches the correct workspace by HMAC signature", () => {
      registry.register(makeWorkspaceConfig({ id: "ws-A", webhookSecret: "secret-A" }), logger);
      registry.register(makeWorkspaceConfig({ id: "ws-B", webhookSecret: "secret-B" }), logger);

      const body = '{"action":"create","type":"Issue"}';
      const sigA = sign(body, "secret-A");
      const sigB = sign(body, "secret-B");

      expect(registry.matchBySignature(body, sigA)!.config.id).toBe("ws-A");
      expect(registry.matchBySignature(body, sigB)!.config.id).toBe("ws-B");
    });

    it("returns null for invalid signature", () => {
      registry.register(makeWorkspaceConfig({ webhookSecret: "real-secret" }), logger);

      const body = '{"action":"create","type":"Issue"}';
      const badSig = sign(body, "wrong-secret");

      expect(registry.matchBySignature(body, badSig)).toBeNull();
    });

    it("returns null when no workspaces registered", () => {
      expect(registry.matchBySignature("body", "sig")).toBeNull();
    });
  });

  describe("resolveByAgentId", () => {
    it("resolves workspace from agent mapping", () => {
      registry.register(
        makeWorkspaceConfig({
          id: "ws-X",
          agentMapping: { "uuid-1": "titus", "uuid-2": "scout" },
        }),
        logger,
      );
      registry.register(
        makeWorkspaceConfig({
          id: "ws-Y",
          agentMapping: { "uuid-3": "other-agent" },
        }),
        logger,
      );

      expect(registry.resolveByAgentId("titus")!.config.id).toBe("ws-X");
      expect(registry.resolveByAgentId("scout")!.config.id).toBe("ws-X");
      expect(registry.resolveByAgentId("other-agent")!.config.id).toBe("ws-Y");
    });

    it("returns undefined for unknown agent", () => {
      registry.register(
        makeWorkspaceConfig({ agentMapping: { "uuid-1": "titus" } }),
        logger,
      );
      expect(registry.resolveByAgentId("unknown-agent")).toBeUndefined();
    });
  });

  describe("routeEvent", () => {
    it("uses workspace-specific event router", () => {
      registry.register(
        makeWorkspaceConfig({
          id: "ws-filtered",
          agentMapping: { "user-1": "agent-1" },
          eventFilter: ["Comment"], // Only Comment events
        }),
        logger,
      );

      const ws = registry.get("ws-filtered")!;

      // Issue events should be filtered out
      const issueActions = ws.routeEvent({
        action: "create",
        type: "Issue",
        data: { id: "i1", assigneeId: "user-1", identifier: "ENG-1" },
        createdAt: "2026-01-01T00:00:00Z",
      });
      expect(issueActions).toEqual([]);
    });
  });
});
