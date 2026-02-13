import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createWebhookHandler } from "./webhook-handler.js";
import { createEventRouter } from "./event-router.js";
import { createLinearClient } from "./linear-client.js";
import { registerCreateIssueTool } from "./tools/create-issue.js";
import { registerListIssuesTool } from "./tools/list-issues.js";
import { registerUpdateIssueTool } from "./tools/update-issue.js";
import { registerAddCommentTool } from "./tools/add-comment.js";

export function activate(api: OpenClawPluginApi): void {
  api.logger.info("Linear plugin activated");

  // Register agent tools if API key is available
  const apiKey = api.pluginConfig?.["apiKey"] as string | undefined;
  if (apiKey) {
    const client = createLinearClient(apiKey);
    registerCreateIssueTool(api, client);
    registerListIssuesTool(api, client);
    registerUpdateIssueTool(api, client);
    registerAddCommentTool(api, client);
    api.logger.info("Linear agent tools registered (4 tools)");
  }

  const webhookSecret = api.pluginConfig?.["webhookSecret"];
  if (typeof webhookSecret === "string" && webhookSecret) {
    const userMap = (api.pluginConfig?.["userMap"] as Record<string, string>) ?? {};
    const route = createEventRouter({ userMap, logger: api.logger });

    const handler = createWebhookHandler({
      webhookSecret,
      logger: api.logger,
      onEvent: (event) => {
        const actions = route(event);
        for (const action of actions) {
          api.logger.info(
            `[event-router] ${action.type} agent=${action.agentId} event=${action.event}: ${action.detail}`,
          );
        }
      },
    });

    api.registerHttpRoute({
      path: "/hooks/linear",
      handler,
    });

    api.logger.info("Linear webhook handler registered at /hooks/linear");
  }
}

export function deactivate(api: OpenClawPluginApi): void {
  api.logger.info("Linear plugin deactivated");
}

const plugin = {
  id: "linear",
  name: "Linear",
  description: "Linear project management integration for OpenClaw",
  activate,
} satisfies {
  id: string;
  name: string;
  description: string;
  activate: (api: OpenClawPluginApi) => void;
};

export default plugin;
