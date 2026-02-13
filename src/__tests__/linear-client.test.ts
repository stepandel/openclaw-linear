import { describe, it, expect } from "vitest";
import { withRetry, formatLinearError, createLinearClient } from "../linear-client.js";

describe("createLinearClient", () => {
  it("throws on empty API key", () => {
    expect(() => createLinearClient("")).toThrow("API key is required");
  });
});

describe("withRetry", () => {
  it("returns on first success", async () => {
    const result = await withRetry(async () => "ok");
    expect(result).toBe("ok");
  });

  it("retries on rate limit (429) and succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) {
        throw Object.assign(new Error("rate limited"), { response: { status: 429 } });
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("retries on 500 server error", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 2) {
        throw Object.assign(new Error("server error"), { response: { status: 500 } });
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("throws after max retries on persistent rate limit", async () => {
    await expect(
      withRetry(async () => {
        throw Object.assign(new Error("rate limited"), { response: { status: 429 } });
      }),
    ).rejects.toThrow("rate limited");
  });

  it("does not retry on 400 client error", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw Object.assign(new Error("bad request"), { response: { status: 400 } });
      }),
    ).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });
});

describe("formatLinearError", () => {
  it("formats 401 as auth error", () => {
    const err = Object.assign(new Error("bad"), { status: 401 });
    expect(formatLinearError(err)).toContain("authentication");
  });

  it("formats 429 as rate limit", () => {
    const err = Object.assign(new Error("bad"), { status: 429 });
    expect(formatLinearError(err)).toContain("rate limit");
  });

  it("formats generic Error", () => {
    expect(formatLinearError(new Error("oops"))).toBe("Linear API error: oops");
  });

  it("formats non-Error values", () => {
    expect(formatLinearError("string err")).toContain("string err");
  });
});
