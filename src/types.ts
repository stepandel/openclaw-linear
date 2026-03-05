/**
 * Context passed to tool factories by the plugin SDK.
 * Re-declared here to avoid importing from internal SDK paths.
 */
export type OpenClawPluginToolContext = {
  config?: unknown;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
  sandboxed?: boolean;
};
