import { LinearClient } from "@linear/sdk";

const MAX_RETRIES = 2;
const RATE_LIMIT_DELAY_MS = 1000;

export function createLinearClient(apiKey: string): LinearClient {
  if (!apiKey) {
    throw new Error(
      "Linear API key is required. Generate one at https://linear.app/settings/api",
    );
  }
  return new LinearClient({ apiKey });
}

/**
 * Wraps an async Linear SDK call with retry logic for rate limits and transient errors.
 * Retries on 429 (rate limit) and 5xx errors up to MAX_RETRIES times.
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const status = err?.response?.status ?? err?.status ?? err?.extensions?.code;
      const isRateLimit = status === 429 || status === "RATELIMITED";
      const isServerError =
        typeof status === "number" && status >= 500 && status < 600;

      if ((isRateLimit || isServerError) && attempt < MAX_RETRIES) {
        const delay = isRateLimit
          ? RATE_LIMIT_DELAY_MS * (attempt + 1)
          : 500 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      break;
    }
  }
  throw lastError;
}

/**
 * Formats a Linear API error into a user-friendly message.
 */
export function formatLinearError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;
    const status = (err as any)?.response?.status ?? (err as any)?.status;
    if (status === 401 || status === 403 || msg.includes("authentication") || msg.includes("401")) {
      return "Linear authentication failed. Check the API key.";
    }
    if (status === 429 || msg.includes("rate") || msg.includes("429")) {
      return "Linear rate limit exceeded. Please try again shortly.";
    }
    return `Linear API error: ${msg}`;
  }
  return `Linear API error: ${String(err)}`;
}
