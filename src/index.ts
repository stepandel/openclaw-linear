import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createWebhookHandler } from "./webhook-handler.js";

export function activate(api: OpenClawPluginApi): void {
  api.logger.info("Linear plugin activated");

  const webhookSecret = api.pluginConfig?.["webhookSecret"];
  if (typeof webhookSecret === "string" && webhookSecret) {
    const handler = createWebhookHandler({
      webhookSecret,
      logger: api.logger,
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
