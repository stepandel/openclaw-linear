import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export type LinearWebhookPayload = {
  action: string;
  type: string;
  data: Record<string, unknown>;
  updatedFrom?: Record<string, unknown>;
  createdAt: string;
};

type WebhookHandlerDeps = {
  webhookSecret: string | string[];
  logger: {
    info: (message: string) => void;
    error: (message: string) => void;
  };
  onEvent?: (event: LinearWebhookPayload) => void;
  onStatus?: (status: LinearWebhookStatus) => void;
};

export type LinearWebhookStatus = {
  schemaVersion: "linear.webhook_status.v1";
  observedAt: string;
  classification:
    | "accepted_ingress"
    | "duplicate_replay"
    | "invalid_refusal"
    | "unavailable_state";
  state: "accepted" | "duplicate" | "refused" | "unavailable";
  reason: string;
  eventClass: string;
  issueKey?: string;
  deliveryHash?: string;
  httpStatus?: number;
};

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEDUP_MAX_SIZE = 10_000;
const ALLOWED_EVENT_ACTIONS: Record<string, Set<string>> = {
  Issue: new Set(["create", "update", "remove"]),
  Comment: new Set(["create", "update"]),
};

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validatePayloadShape(payload: unknown): { ok: boolean; action: string; type: string } {
  const record = objectRecord(payload);
  const action = typeof record.action === "string" ? record.action : "";
  const type = typeof record.type === "string" ? record.type : "";
  const allowedActions = ALLOWED_EVENT_ACTIONS[type];
  if (!allowedActions || !allowedActions.has(action)) {
    return { ok: false, action, type };
  }
  return { ok: true, action, type };
}

function deliveryHash(deliveryId: string): string {
  return `sha256:${createHash("sha256").update(deliveryId).digest("hex").slice(0, 16)}`;
}

function eventClassFromPayload(payload: unknown): string {
  const record = objectRecord(payload);
  const type = String(record.type ?? "");
  const action = String(record.action ?? "");
  return [type, action].filter(Boolean).join(".") || "webhook.event";
}

function issueKeyFromPayload(payload: unknown): string | undefined {
  const record = objectRecord(payload);
  const data = objectRecord(record.data ?? payload);
  const issue = objectRecord(data.issue);
  const identifier = data.identifier ?? issue.identifier;
  return typeof identifier === "string" && identifier ? identifier : undefined;
}

function recordStatus(
  deps: WebhookHandlerDeps,
  status: Omit<LinearWebhookStatus, "schemaVersion" | "observedAt">,
): void {
  try {
    deps.onStatus?.({
      schemaVersion: "linear.webhook_status.v1",
      observedAt: new Date().toISOString(),
      ...status,
    });
  } catch (err) {
    deps.logger.error(`Webhook status recorder error: ${formatErrorMessage(err)}`);
  }
}

function verifySignature(body: string, signature: string, secret: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(body).digest();
  const provided = Buffer.from(signature, "hex");
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createWebhookHandler(deps: WebhookHandlerDeps) {
  /** Map of delivery ID → timestamp for duplicate detection with TTL. */
  const processedDeliveries = new Map<string, number>();

  function pruneDeliveries(): void {
    const now = Date.now();
    for (const [id, ts] of processedDeliveries) {
      if (now - ts > DEDUP_TTL_MS) {
        processedDeliveries.delete(id);
      }
    }
    if (processedDeliveries.size > DEDUP_MAX_SIZE) {
      const excess = processedDeliveries.size - DEDUP_MAX_SIZE;
      const iter = processedDeliveries.keys();
      for (let i = 0; i < excess; i++) {
        const key = iter.next().value;
        if (key !== undefined) processedDeliveries.delete(key);
      }
    }
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      recordStatus(deps, {
        classification: "invalid_refusal",
        state: "refused",
        reason: "method_not_allowed",
        eventClass: "webhook.method",
        httpStatus: 405,
      });
      res.writeHead(405, { Allow: "POST" });
      res.end("Method Not Allowed");
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readBody(req);
    } catch (err) {
      const msg = formatErrorMessage(err);
      if (msg.includes("too large")) {
        recordStatus(deps, {
          classification: "invalid_refusal",
          state: "refused",
          reason: "payload_too_large",
          eventClass: "webhook.body",
          httpStatus: 413,
        });
        res.writeHead(413);
        res.end("Payload Too Large");
      } else {
        recordStatus(deps, {
          classification: "unavailable_state",
          state: "unavailable",
          reason: "body_read_error",
          eventClass: "webhook.body",
          httpStatus: 500,
        });
        res.writeHead(500);
        res.end("Internal Server Error");
      }
      return;
    }

    const signature = req.headers["linear-signature"];
    const secrets = Array.isArray(deps.webhookSecret) ? deps.webhookSecret : [deps.webhookSecret];
    const signatureValid = typeof signature === "string" && secrets.some((s) => verifySignature(rawBody, signature, s));
    if (!signatureValid) {
      recordStatus(deps, {
        classification: "invalid_refusal",
        state: "refused",
        reason: "invalid_signature",
        eventClass: "webhook.signature",
        httpStatus: 400,
      });
      res.writeHead(400);
      res.end("Invalid signature");
      return;
    }

    let event: LinearWebhookPayload;
    try {
      const payload = JSON.parse(rawBody) as Record<string, unknown>;
      const shape = validatePayloadShape(payload);
      if (!shape.ok) {
        recordStatus(deps, {
          classification: "invalid_refusal",
          state: "refused",
          reason: "unsupported_event",
          eventClass: eventClassFromPayload(payload),
          issueKey: issueKeyFromPayload(payload),
          httpStatus: 400,
        });
        deps.logger.info(`Webhook rejected: unsupported event action=${shape.action || "(missing)"} type=${shape.type || "(missing)"}`);
        res.writeHead(400);
        res.end("Unsupported event");
        return;
      }

      const deliveryHeader = req.headers["linear-delivery"];
      const deliveryId = typeof deliveryHeader === "string" ? deliveryHeader : undefined;

      // Prune expired entries periodically
      pruneDeliveries();

      if (deliveryId) {
        if (processedDeliveries.has(deliveryId)) {
          recordStatus(deps, {
            classification: "duplicate_replay",
            state: "duplicate",
            reason: "duplicate_delivery",
            eventClass: eventClassFromPayload(payload),
            issueKey: issueKeyFromPayload(payload),
            deliveryHash: deliveryHash(deliveryId),
            httpStatus: 200,
          });
          deps.logger.info(`Duplicate delivery skipped: ${deliveryId}`);
          res.writeHead(200);
          res.end("OK");
          return;
        }
        processedDeliveries.set(deliveryId, Date.now());
      }

      event = {
        action: String(payload.action ?? ""),
        type: String(payload.type ?? ""),
        // Some Linear webhook payloads (e.g. OAuth App events) place fields
        // directly on the top-level object instead of nesting under `data`.
        // Fall back to the full payload so downstream handlers still see data.
        data: objectRecord(payload.data ?? payload),
        updatedFrom: (payload.updatedFrom as Record<string, unknown>) ?? undefined,
        createdAt: String(payload.createdAt ?? ""),
      };

      recordStatus(deps, {
        classification: "accepted_ingress",
        state: "accepted",
        reason: "signature_valid",
        eventClass: `${event.type}.${event.action}`,
        issueKey: issueKeyFromPayload(payload),
        ...(deliveryId ? { deliveryHash: deliveryHash(deliveryId) } : {}),
        httpStatus: 200,
      });
      deps.logger.info(`Linear webhook: ${event.action} ${event.type} (${String(event.data.id ?? "unknown")})`);
    } catch (err) {
      recordStatus(deps, {
        classification: "invalid_refusal",
        state: "refused",
        reason: "malformed_payload",
        eventClass: "webhook.parse",
        httpStatus: 400,
      });
      deps.logger.error(`Webhook parse error: ${formatErrorMessage(err)}`);
      res.writeHead(400);
      res.end("Malformed payload");
      return;
    }

    // Always return 200 after successful parse — onEvent errors must not
    // cause Linear to retry (which could create a retry storm).
    res.writeHead(200);
    res.end("OK");

    try {
      deps.onEvent?.(event);
    } catch (err) {
      recordStatus(deps, {
        classification: "unavailable_state",
        state: "unavailable",
        reason: "event_handler_error",
        eventClass: `${event.type}.${event.action}`,
      });
      deps.logger.error(`Event handler error: ${formatErrorMessage(err)}`);
    }
  };
}
