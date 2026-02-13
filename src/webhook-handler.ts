import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type LinearWebhookPayload = {
  action: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
};

type WebhookHandlerDeps = {
  webhookSecret: string;
  logger: {
    info: (message: string) => void;
    error: (message: string) => void;
  };
};

const processedDeliveryIds = new Set<string>();

function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (expected.length !== signature.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createWebhookHandler(deps: WebhookHandlerDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end("Method Not Allowed");
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readBody(req);
    } catch {
      res.writeHead(500);
      res.end("Internal Server Error");
      return;
    }

    const signature = req.headers["linear-signature"];
    if (typeof signature !== "string" || !verifySignature(rawBody, signature, deps.webhookSecret)) {
      res.writeHead(400);
      res.end("Invalid signature");
      return;
    }

    try {
      const payload = JSON.parse(rawBody) as Record<string, unknown>;
      const deliveryId = req.headers["linear-delivery"] as string | undefined;

      if (deliveryId) {
        if (processedDeliveryIds.has(deliveryId)) {
          deps.logger.info(`Duplicate delivery skipped: ${deliveryId}`);
          res.writeHead(200);
          res.end("OK");
          return;
        }
        processedDeliveryIds.add(deliveryId);
      }

      const event: LinearWebhookPayload = {
        action: String(payload.action ?? ""),
        type: String(payload.type ?? ""),
        data: (payload.data as Record<string, unknown>) ?? {},
        createdAt: String(payload.createdAt ?? ""),
      };

      deps.logger.info(`Linear webhook: ${event.action} ${event.type} (${String(event.data.id ?? "unknown")})`);

      res.writeHead(200);
      res.end("OK");
    } catch (err) {
      deps.logger.error(`Webhook processing error: ${err instanceof Error ? err.message : String(err)}`);
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  };
}
