import {
  TicketSource,
  DEFAULT_TICKET_LABEL,
  DEFAULT_MAX_TICKET_PAGES,
  type Ticket,
  type TicketComment,
  type TicketProviderConfig,
} from "@optio/shared";
import type { TicketProvider } from "./types.js";

export interface GitLabProviderConfig extends TicketProviderConfig {
  token: string;
  /** GitLab project path, e.g. "group/project" or "group/subgroup/project" */
  projectPath: string;
  /** GitLab host, defaults to "gitlab.com" */
  host?: string;
  label?: string;
  maxPages?: number;
}

function asGitLabConfig(config: TicketProviderConfig): GitLabProviderConfig {
  const c = config as GitLabProviderConfig;
  if (!c.token || !c.projectPath) {
    throw new Error("GitLab provider requires token and projectPath in config");
  }
  return c;
}

export class GitLabTicketProvider implements TicketProvider {
  readonly source = TicketSource.GITLAB;

  private apiUrl(config: GitLabProviderConfig): string {
    const host = config.host ?? "gitlab.com";
    return `https://${host}/api/v4`;
  }

  private projectId(config: GitLabProviderConfig): string {
    return encodeURIComponent(config.projectPath);
  }

  private headers(config: GitLabProviderConfig): Record<string, string> {
    return { "PRIVATE-TOKEN": config.token, "Content-Type": "application/json" };
  }

  async fetchActionableTickets(config: TicketProviderConfig): Promise<Ticket[]> {
    const glConfig = asGitLabConfig(config);
    const label = glConfig.label ?? DEFAULT_TICKET_LABEL;
    const maxPages = glConfig.maxPages ?? DEFAULT_MAX_TICKET_PAGES;
    const baseUrl = this.apiUrl(glConfig);
    const pid = this.projectId(glConfig);
    const hdrs = this.headers(glConfig);
    const host = glConfig.host ?? "gitlab.com";

    const allTickets: Ticket[] = [];
    let page = 1;

    while (page <= maxPages) {
      const params = new URLSearchParams({
        labels: label,
        state: "opened",
        per_page: "100",
        page: String(page),
      });

      const res = await fetch(`${baseUrl}/projects/${pid}/issues?${params}`, { headers: hdrs });
      if (!res.ok) break;

      const issues = (await res.json()) as any[];
      if (issues.length === 0) break;

      for (const issue of issues) {
        allTickets.push({
          externalId: String(issue.iid),
          source: TicketSource.GITLAB,
          title: issue.title ?? "",
          body: issue.description ?? "",
          url: issue.web_url ?? `https://${host}/${glConfig.projectPath}/-/issues/${issue.iid}`,
          labels: issue.labels ?? [],
          assignee: issue.assignee?.username,
          repo: glConfig.projectPath,
          metadata: {
            number: issue.iid,
            createdAt: issue.created_at,
            updatedAt: issue.updated_at,
          },
        });
      }

      // Check for next page
      const totalPages = parseInt(res.headers.get("x-total-pages") ?? "1", 10);
      if (page >= totalPages) break;
      page++;
    }

    return allTickets;
  }

  async fetchTicketComments(
    ticketId: string,
    config: TicketProviderConfig,
  ): Promise<TicketComment[]> {
    const glConfig = asGitLabConfig(config);
    const baseUrl = this.apiUrl(glConfig);
    const pid = this.projectId(glConfig);
    const hdrs = this.headers(glConfig);

    const res = await fetch(
      `${baseUrl}/projects/${pid}/issues/${ticketId}/notes?sort=asc&per_page=30`,
      { headers: hdrs },
    );
    if (!res.ok) return [];

    const notes = (await res.json()) as any[];
    return notes
      .filter((n: any) => !n.system)
      .map((n: any) => ({
        author: n.author?.username ?? "unknown",
        body: n.body ?? "",
        createdAt: n.created_at ?? "",
      }));
  }

  async addComment(ticketId: string, comment: string, config: TicketProviderConfig): Promise<void> {
    const glConfig = asGitLabConfig(config);
    const baseUrl = this.apiUrl(glConfig);
    const pid = this.projectId(glConfig);
    const hdrs = this.headers(glConfig);

    await fetch(`${baseUrl}/projects/${pid}/issues/${ticketId}/notes`, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ body: comment }),
    });
  }

  async updateState(
    ticketId: string,
    state: "open" | "closed",
    config: TicketProviderConfig,
  ): Promise<void> {
    const glConfig = asGitLabConfig(config);
    const baseUrl = this.apiUrl(glConfig);
    const pid = this.projectId(glConfig);
    const hdrs = this.headers(glConfig);

    const stateEvent = state === "closed" ? "close" : "reopen";
    await fetch(`${baseUrl}/projects/${pid}/issues/${ticketId}`, {
      method: "PUT",
      headers: hdrs,
      body: JSON.stringify({ state_event: stateEvent }),
    });
  }
}
