const API_URL = "https://api.linear.app/graphql";

export class LinearClient {
  private readonly apiKey: string;
  private readonly issueIdCache = new Map<string, string>();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async graphql<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.text();
        if (body) detail += `: ${body}`;
      } catch {
        // ignore read errors
      }
      throw new Error(`Linear API HTTP ${res.status}: ${detail}`);
    }

    const json = (await res.json()) as {
      data?: T;
      errors?: { message: string }[];
    };

    if (json.errors?.length) {
      throw new Error(`Linear API error: ${json.errors[0].message}`);
    }

    return json.data as T;
  }

  async resolveIssueId(identifier: string): Promise<string> {
    const cached = this.issueIdCache.get(identifier);
    if (cached) return cached;

    const match = identifier.match(/^([A-Za-z]+)-(\d+)$/);
    if (!match) {
      throw new Error(`Invalid issue identifier format: ${identifier} (expected e.g. ENG-123)`);
    }

    const [, teamKey, numStr] = match;
    const num = parseInt(numStr, 10);

    const data = await this.graphql<{
      issues: { nodes: { id: string }[] };
    }>(
      `query($teamKey: String!, $num: Float!) {
        issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $num } }) {
          nodes { id }
        }
      }`,
      { teamKey: teamKey.toUpperCase(), num },
    );

    if (data.issues.nodes.length === 0) {
      throw new Error(`Issue ${identifier} not found`);
    }

    const id = data.issues.nodes[0].id;
    this.issueIdCache.set(identifier, id);
    return id;
  }

  /** Reset issue ID cache (for testing). */
  _resetIssueIdCache(): void {
    this.issueIdCache.clear();
  }

  async resolveTeamId(key: string): Promise<string> {
    const data = await this.graphql<{
      teams: { nodes: { id: string }[] };
    }>(
      `query($key: String!) {
        teams(filter: { key: { eq: $key } }) {
          nodes { id }
        }
      }`,
      { key: key.toUpperCase() },
    );

    if (data.teams.nodes.length === 0) {
      throw new Error(`Team with key "${key}" not found`);
    }
    return data.teams.nodes[0].id;
  }

  async resolveStateId(
    teamId: string,
    stateName: string,
  ): Promise<string> {
    const data = await this.graphql<{
      team: { states: { nodes: { id: string; name: string }[] } };
    }>(
      `query($teamId: String!) {
        team(id: $teamId) {
          states { nodes { id name } }
        }
      }`,
      { teamId },
    );

    const lowerName = stateName.toLowerCase();
    const match = data.team.states.nodes.find(
      (s) => s.name.toLowerCase() === lowerName,
    );

    if (!match) {
      const available = data.team.states.nodes.map((s) => s.name).join(", ");
      throw new Error(
        `Workflow state "${stateName}" not found. Available states: ${available}`,
      );
    }
    return match.id;
  }

  async resolveUserId(nameOrEmail: string): Promise<string> {
    const data = await this.graphql<{
      users: { nodes: { id: string }[] };
    }>(
      `query($term: String!) {
        users(filter: { or: [{ name: { eqIgnoreCase: $term } }, { email: { eq: $term } }] }) {
          nodes { id }
        }
      }`,
      { term: nameOrEmail },
    );

    if (data.users.nodes.length === 0) {
      throw new Error(`User "${nameOrEmail}" not found`);
    }
    return data.users.nodes[0].id;
  }

  async resolveLabelIds(
    teamId: string,
    names: string[],
  ): Promise<string[]> {
    const data = await this.graphql<{
      team: { labels: { nodes: { id: string; name: string }[] } };
    }>(
      `query($teamId: String!) {
        team(id: $teamId) {
          labels { nodes { id name } }
        }
      }`,
      { teamId },
    );

    const labelMap = new Map(
      data.team.labels.nodes.map((l) => [l.name.toLowerCase(), l.id]),
    );

    const ids: string[] = [];
    for (const name of names) {
      const id = labelMap.get(name.toLowerCase());
      if (!id) {
        throw new Error(`Label "${name}" not found in team`);
      }
      ids.push(id);
    }
    return ids;
  }

  async resolveProjectId(name: string): Promise<string> {
    const data = await this.graphql<{
      projects: { nodes: { id: string; name: string }[] };
    }>(
      `query($name: String!) {
        projects(filter: { name: { eqIgnoreCase: $name } }) {
          nodes { id name }
        }
      }`,
      { name },
    );

    if (data.projects.nodes.length === 0) {
      throw new Error(`Project "${name}" not found`);
    }
    return data.projects.nodes[0].id;
  }
}
