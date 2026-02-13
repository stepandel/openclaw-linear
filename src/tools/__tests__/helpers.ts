import { vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export function makeApi() {
  const tools: Record<string, any> = {};
  return {
    api: {
      logger: { info: vi.fn(), error: vi.fn() },
      registerTool(def: any) {
        tools[def.name] = def;
      },
    } as unknown as OpenClawPluginApi,
    getTool(name: string) {
      return tools[name];
    },
  };
}

export function makeClient(overrides: Record<string, any> = {}) {
  return {
    teams: vi.fn().mockResolvedValue({ nodes: [] }),
    issues: vi.fn().mockResolvedValue({ nodes: [] }),
    searchIssues: vi.fn().mockResolvedValue({ nodes: [] }),
    issueLabels: vi.fn().mockResolvedValue({ nodes: [] }),
    createIssue: vi.fn().mockResolvedValue({ issue: Promise.resolve(null) }),
    updateIssue: vi.fn().mockResolvedValue({}),
    createComment: vi.fn().mockResolvedValue({ comment: Promise.resolve(null) }),
    organization: Promise.resolve({ users: vi.fn().mockResolvedValue({ nodes: [] }) }),
    ...overrides,
  } as any;
}
