import { createHmac, timingSafeEqual } from "node:crypto";
import { LinearClient } from "./linear-client.js";
import { createEventRouter } from "./event-router.js";

export interface WorkspaceConfig {
  id: string;
  apiKey: string;
  webhookSecret: string;
  agentMapping: Record<string, string>;
  teamIds?: string[];
  eventFilter?: string[];
  stateActions?: Record<string, string>;
}

export interface Workspace {
  config: WorkspaceConfig;
  client: LinearClient;
  routeEvent: ReturnType<typeof createEventRouter>;
}

function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (expected.length !== signature.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly agentIdIndex = new Map<string, Workspace>();

  register(
    config: WorkspaceConfig,
    logger: { info: (message: string) => void; error: (message: string) => void },
  ): void {
    const client = new LinearClient(config.apiKey);

    const routeEvent = createEventRouter({
      agentMapping: config.agentMapping,
      logger,
      eventFilter: config.eventFilter?.length ? config.eventFilter : undefined,
      teamIds: config.teamIds?.length ? config.teamIds : undefined,
      stateActions: config.stateActions,
    });

    const workspace: Workspace = { config, client, routeEvent };
    this.workspaces.set(config.id, workspace);

    // Build reverse index: agentId → workspace
    for (const agentId of Object.values(config.agentMapping)) {
      this.agentIdIndex.set(agentId, workspace);
    }
  }

  /** Try each workspace's secret until one matches. Returns null if none match. */
  matchBySignature(rawBody: string, signature: string): Workspace | null {
    for (const workspace of this.workspaces.values()) {
      if (verifySignature(rawBody, signature, workspace.config.webhookSecret)) {
        return workspace;
      }
    }
    return null;
  }

  get(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  getDefault(): Workspace | undefined {
    const iter = this.workspaces.values();
    const first = iter.next();
    return first.done ? undefined : first.value;
  }

  all(): Workspace[] {
    return [...this.workspaces.values()];
  }

  /** Reverse lookup: agentId → workspace (built from agentMappings). */
  resolveByAgentId(agentId: string): Workspace | undefined {
    return this.agentIdIndex.get(agentId);
  }

  get size(): number {
    return this.workspaces.size;
  }
}
