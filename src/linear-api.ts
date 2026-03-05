import { LinearClient } from "./linear-client.js";

let defaultClient: LinearClient | undefined;

export function setApiKey(key: string): void {
  defaultClient = new LinearClient(key);
}

/** Reset API key (for testing). */
export function _resetApiKey(): void {
  defaultClient = undefined;
}

function getClient(): LinearClient {
  if (!defaultClient) {
    throw new Error("Linear API key not set — call setApiKey() first");
  }
  return defaultClient;
}

export async function graphql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  return getClient().graphql<T>(query, variables);
}

export async function resolveIssueId(identifier: string): Promise<string> {
  return getClient().resolveIssueId(identifier);
}

/** Reset issue ID cache (for testing). */
export function _resetIssueIdCache(): void {
  defaultClient?._resetIssueIdCache();
}

export async function resolveTeamId(key: string): Promise<string> {
  return getClient().resolveTeamId(key);
}

export async function resolveStateId(
  teamId: string,
  stateName: string,
): Promise<string> {
  return getClient().resolveStateId(teamId, stateName);
}

export async function resolveUserId(nameOrEmail: string): Promise<string> {
  return getClient().resolveUserId(nameOrEmail);
}

export async function resolveLabelIds(
  teamId: string,
  names: string[],
): Promise<string[]> {
  return getClient().resolveLabelIds(teamId, names);
}

export async function resolveProjectId(name: string): Promise<string> {
  return getClient().resolveProjectId(name);
}
