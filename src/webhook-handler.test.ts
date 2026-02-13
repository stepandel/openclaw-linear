import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWebhookHandler } from "./webhook-handler.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const SECRET = "test-webhook-secret";

function makeLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

function makeReq(
  body: string,
  headers: Record<string, string> = {},
  method = "POST",
): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  // Emit body asynchronously
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function makeRes(): ServerResponse & { body: string; statusCode: number } {
  const res = {
    statusCode: 200,
    body: "",
    writeHead(code: number) {
      res.statusCode = code;
    },
    end(data?: string) {
      res.body = data ?? "";
    },
  } as unknown as ServerResponse & { body: string; statusCode: number };
  return res;
}

describe("webhook-handler", () => {
  let logger: ReturnType<typeof makeLogger>;
  let handler: ReturnType<typeof createWebhookHandler>;

  beforeEach(() => {
    logger = makeLogger();
    handler = createWebhookHandler({ webhookSecret: SECRET, logger });
  });

  it("returns 200 for valid signature", async () => {
    const body = JSON.stringify({
      action: "create",
      type: "Issue",
      data: { id: "issue-1", title: "Test" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const req = makeReq(body, { "Linear-Signature": sign(body) });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("OK");
    expect(logger.info).toHaveBeenCalledWith(
      "Linear webhook: create Issue (issue-1)",
    );
  });

  it("returns 400 for invalid signature", async () => {
    const body = JSON.stringify({ action: "update", type: "Issue", data: {}, createdAt: "" });
    const req = makeReq(body, { "Linear-Signature": "invalidsignature" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("Invalid signature");
  });

  it("returns 400 when signature header is missing", async () => {
    const body = JSON.stringify({ action: "update", type: "Issue", data: {}, createdAt: "" });
    const req = makeReq(body, {});
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("detects and skips duplicate deliveries", async () => {
    const body = JSON.stringify({
      action: "update",
      type: "Issue",
      data: { id: "issue-2" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const headers = {
      "Linear-Signature": sign(body),
      "Linear-Delivery": "delivery-dup-test-123",
    };

    // First request
    const req1 = makeReq(body, headers);
    const res1 = makeRes();
    await handler(req1, res1);
    expect(res1.statusCode).toBe(200);

    // Second request with same delivery ID
    const req2 = makeReq(body, headers);
    const res2 = makeRes();
    await handler(req2, res2);
    expect(res2.statusCode).toBe(200);
    expect(logger.info).toHaveBeenCalledWith(
      "Duplicate delivery skipped: delivery-dup-test-123",
    );
  });

  it("returns 500 for malformed JSON payload", async () => {
    const body = "not valid json {{{";
    const req = makeReq(body, { "Linear-Signature": sign(body) });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(logger.error).toHaveBeenCalled();
  });

  it("returns 405 for non-POST methods", async () => {
    const req = makeReq("", {}, "GET");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
