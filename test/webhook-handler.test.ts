import { createHash, createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createWebhookHandler } from "../src/webhook-handler.js";

function signingKey(): string {
  return createHash("sha256").update("openclaw-linear-public-test-key").digest("hex");
}

const SECRET = signingKey();

function makeLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
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
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function makeRes(): ServerResponse & {
  body: string;
  headers?: unknown;
  statusCode: number;
} {
  const res = {
    statusCode: 200,
    headers: undefined as unknown,
    body: "",
    writeHead(code: number, headers?: unknown) {
      res.statusCode = code;
      res.headers = headers;
    },
    end(data?: string) {
      res.body = data ?? "";
    },
  } as unknown as ServerResponse & { body: string; headers?: unknown; statusCode: number };
  return res;
}

function issuePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "update",
    type: "Issue",
    data: {
      id: "issue-id",
      identifier: "OC-T",
      title: "Test issue",
    },
    createdAt: "2026-06-08T00:00:00.000Z",
    ...overrides,
  });
}

function createHarness() {
  const statuses: unknown[] = [];
  const events: unknown[] = [];
  const logs: string[] = [];
  const logger = {
    info: vi.fn((message: string) => logs.push(message)),
    error: vi.fn((message: string) => logs.push(message)),
  };
  const handler = createWebhookHandler({
    webhookSecret: SECRET,
    onStatus: (status) => statuses.push(status),
    onEvent: (event) => events.push(event),
    logger,
  });
  return { events, handler, logger, logs, statuses };
}

async function invoke(
  handler: ReturnType<typeof createWebhookHandler>,
  {
    body = issuePayload(),
    delivery = "delivery-1",
    secret = SECRET,
    signature,
  }: {
    body?: string;
    delivery?: string;
    secret?: string;
    signature?: string;
  } = {},
) {
  const req = makeReq(body, {
    ...(delivery ? { "Linear-Delivery": delivery } : {}),
    ...(signature === undefined
      ? { "Linear-Signature": sign(body, secret) }
      : signature
        ? { "Linear-Signature": signature }
        : {}),
  });
  const res = makeRes();
  await handler(req, res);
  return res;
}

describe("openclaw-linear manifest contract", () => {
  it("allows webhookSecret as either a string or a SecretRef and declares the runtime secret input path", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    );
    const webhookSecret = manifest.configSchema.properties.webhookSecret;
    const variants = webhookSecret.anyOf;

    expect(variants).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "string", minLength: 1 }),
      expect.objectContaining({ $ref: "#/$defs/secretRef" }),
    ]));
    expect(manifest.configSchema.$defs.secretRef.required).toEqual(["source", "provider", "id"]);
    expect(manifest.configContracts.secretInputs.paths).toContainEqual({
      path: "webhookSecret",
      expected: "string",
    });
  });
});

describe("webhook-handler", () => {
  let logger: ReturnType<typeof makeLogger>;
  let handler: ReturnType<typeof createWebhookHandler>;

  beforeEach(() => {
    logger = makeLogger();
    handler = createWebhookHandler({ webhookSecret: SECRET, logger });
  });

  it("accepts a valid HMAC delivery without exposing signing material", async () => {
    const { events, handler: harnessHandler, logs, statuses } = createHarness();
    const body = issuePayload();
    const signature = sign(body);
    const res = await invoke(harnessHandler, {
      body,
      delivery: "delivery-valid",
      signature,
    });

    expect(res.statusCode).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "update", type: "Issue" });
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        classification: "accepted_ingress",
        state: "accepted",
        reason: "signature_valid",
        deliveryHash: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
      }),
    ]));
    expect(JSON.stringify(statuses)).not.toContain(SECRET);
    expect(JSON.stringify(statuses)).not.toContain(signature);
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain(signature);
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

  it("refuses unsigned and invalid deliveries without dispatching events", async () => {
    const { events, handler: harnessHandler, statuses } = createHarness();
    const unsigned = await invoke(harnessHandler, { signature: "" });
    const invalid = await invoke(harnessHandler, {
      delivery: "delivery-invalid",
      signature: "bad-signature",
    });

    expect(unsigned.statusCode).toBe(400);
    expect(invalid.statusCode).toBe(400);
    expect(events).toHaveLength(0);
    expect(statuses.filter((status) => (status as { reason?: string }).reason === "invalid_signature")).toHaveLength(2);
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

  it("records duplicate delivery replay without dispatching the event twice", async () => {
    const { events, handler: harnessHandler, statuses } = createHarness();

    const first = await invoke(harnessHandler, { delivery: "delivery-replay" });
    const second = await invoke(harnessHandler, { delivery: "delivery-replay" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(events).toHaveLength(1);
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        classification: "duplicate_replay",
        state: "duplicate",
        reason: "duplicate_delivery",
        deliveryHash: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
      }),
    ]));
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

    const req1 = makeReq(body, headers);
    const res1 = makeRes();
    await handler(req1, res1);
    expect(res1.statusCode).toBe(200);

    const req2 = makeReq(body, headers);
    const res2 = makeRes();
    await handler(req2, res2);
    expect(res2.statusCode).toBe(200);
    expect(logger.info).toHaveBeenCalledWith(
      "Duplicate delivery skipped: delivery-dup-test-123",
    );
  });

  it("fails closed for unsupported and malformed payloads", async () => {
    const { events, handler: harnessHandler, statuses } = createHarness();
    const unsupportedBody = issuePayload({ action: "archive", type: "UnknownType" });
    const unsupported = await invoke(harnessHandler, {
      body: unsupportedBody,
      delivery: "delivery-unsupported",
    });
    const malformed = await invoke(harnessHandler, {
      body: "{bad json",
      delivery: "delivery-malformed",
    });

    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.body).toBe("Unsupported event");
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).toBe("Malformed payload");
    expect(events).toHaveLength(0);
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "unsupported_event", state: "refused" }),
      expect.objectContaining({ reason: "malformed_payload", state: "refused" }),
    ]));
  });

  it("returns 400 for malformed JSON payload", async () => {
    const body = "not valid json {{{";
    const req = makeReq(body, { "Linear-Signature": sign(body) });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("Malformed payload");
    expect(logger.error).toHaveBeenCalled();
  });

  it("returns 405 for non-POST methods", async () => {
    const req = makeReq("", {}, "GET");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 200 even when onEvent throws", async () => {
    const onEvent = vi.fn(() => {
      throw new Error("handler boom");
    });
    const h = createWebhookHandler({ webhookSecret: SECRET, logger, onEvent });

    const body = JSON.stringify({
      action: "update",
      type: "Issue",
      data: { id: "issue-err" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const req = makeReq(body, { "Linear-Signature": sign(body) });
    const res = makeRes();
    await h(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("OK");
    expect(onEvent).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "Event handler error: handler boom",
    );
  });

  it("captures updatedFrom and passes to onEvent", async () => {
    const onEvent = vi.fn();
    const h = createWebhookHandler({ webhookSecret: SECRET, logger, onEvent });

    const body = JSON.stringify({
      action: "update",
      type: "Issue",
      data: { id: "issue-uf", assigneeId: "user-1" },
      updatedFrom: { assigneeId: null, priority: 3 },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const req = makeReq(body, { "Linear-Signature": sign(body) });
    const res = makeRes();
    await h(req, res);

    expect(res.statusCode).toBe(200);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        updatedFrom: { assigneeId: null, priority: 3 },
        data: expect.objectContaining({ assigneeId: "user-1" }),
      }),
    );
  });

  it("sets updatedFrom to undefined when absent from payload", async () => {
    const onEvent = vi.fn();
    const h = createWebhookHandler({ webhookSecret: SECRET, logger, onEvent });

    const body = JSON.stringify({
      action: "create",
      type: "Issue",
      data: { id: "issue-no-uf" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const req = makeReq(body, { "Linear-Signature": sign(body) });
    const res = makeRes();
    await h(req, res);

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ updatedFrom: undefined }),
    );
  });

  it("accepts signature when webhookSecret is an array", async () => {
    const secrets = ["secret-a", "secret-b", SECRET];
    const h = createWebhookHandler({ webhookSecret: secrets, logger });

    const body = JSON.stringify({
      action: "create",
      type: "Issue",
      data: { id: "issue-multi" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const req = makeReq(body, { "Linear-Signature": sign(body) });
    const res = makeRes();
    await h(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("rejects signature when none of the secrets match", async () => {
    const secrets = ["secret-a", "secret-b"];
    const h = createWebhookHandler({ webhookSecret: secrets, logger });

    const body = JSON.stringify({
      action: "create",
      type: "Issue",
      data: { id: "issue-bad" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const req = makeReq(body, { "Linear-Signature": sign(body) });
    const res = makeRes();
    await h(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("falls back to full payload when data field is missing for an allowed event", async () => {
    const onEvent = vi.fn();
    const h = createWebhookHandler({ webhookSecret: SECRET, logger, onEvent });

    const body = JSON.stringify({
      action: "create",
      type: "Comment",
      id: "comment-1",
      body: "hello",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const req = makeReq(body, { "Linear-Signature": sign(body) });
    const res = makeRes();
    await h(req, res);

    expect(res.statusCode).toBe(200);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ id: "comment-1", body: "hello" }),
      }),
    );
  });

  it("returns 413 for oversized request body", async () => {
    const req = new EventEmitter() as IncomingMessage;
    req.method = "POST";
    req.headers = {};
    const destroy = vi.fn();
    (req as any).destroy = destroy;

    const res = makeRes();

    process.nextTick(() => {
      const chunk = Buffer.alloc(1024 * 1024 + 1, "x");
      req.emit("data", chunk);
    });

    await handler(req, res);
    expect(res.statusCode).toBe(413);
    expect(res.body).toBe("Payload Too Large");
  });
});
