import { LinearClient } from "@linear/sdk";

export function createLinearClient(apiKey: string): LinearClient {
  if (!apiKey) {
    throw new Error(
      "Linear API key is required. Generate one at https://linear.app/settings/api",
    );
  }
  return new LinearClient({ apiKey });
}
