import { Octokit } from "@octokit/rest";
import {
  TicketSource,
  DEFAULT_TICKET_LABEL,
  DEFAULT_MAX_TICKET_PAGES,
  type Ticket,
  type TicketProviderConfig,
} from "@optio/shared";
import type { TicketProvider } from "./types.js";

export interface GitHubProviderConfig extends TicketProviderConfig {
  token: string;
  owner: string;
  repo: string;
  label?: string;
  /** Max pages to fetch (default: DEFAULT_MAX_TICKET_PAGES). Set to prevent runaway pagination. */
  maxPages?: number;
}

function asGitHubConfig(config: TicketProviderConfig): GitHubProviderConfig {
  const c = config as GitHubProviderConfig;
  if (!c.token || !c.owner || !c.repo) {
    throw new Error("GitHub provider requires token, owner, and repo in config");
  }
  return c;
}

export class GitHubTicketProvider implements TicketProvider {
  readonly source = TicketSource.GITHUB;

  async fetchActionableTickets(config: TicketProviderConfig): Promise<Ticket[]> {
    const ghConfig = asGitHubConfig(config);
    const octokit = new Octokit({ auth: ghConfig.token });
    const label = ghConfig.label ?? DEFAULT_TICKET_LABEL;
    const maxPages = ghConfig.maxPages ?? DEFAULT_MAX_TICKET_PAGES;

    const allTickets: Ticket[] = [];
    let page = 1;

    while (page <= maxPages) {
      const { data: issues, headers } = await octokit.issues.listForRepo({
        owner: ghConfig.owner,
        repo: ghConfig.repo,
        labels: label,
        state: "open",
        per_page: 100,
        page,
      });

      if (issues.length === 0) break;

      for (const issue of issues) {
        if (issue.pull_request) continue;
        allTickets.push({
          externalId: String(issue.number),
          source: TicketSource.GITHUB,
          title: issue.title,
          body: issue.body ?? "",
          url: issue.html_url,
          labels: issue.labels
            .map((l) => (typeof l === "string" ? l : l.name))
            .filter((n): n is string => !!n),
          assignee: issue.assignee?.login,
          repo: `${ghConfig.owner}/${ghConfig.repo}`,
          metadata: {
            number: issue.number,
            createdAt: issue.created_at,
            updatedAt: issue.updated_at,
          },
        });
      }

      // Check if there's a next page via the Link header
      const linkHeader = headers.link ?? "";
      if (!linkHeader.includes('rel="next"')) break;

      page++;
    }

    return allTickets;
  }

  async addComment(ticketId: string, comment: string, config: TicketProviderConfig): Promise<void> {
    const ghConfig = asGitHubConfig(config);
    const octokit = new Octokit({ auth: ghConfig.token });

    await octokit.issues.createComment({
      owner: ghConfig.owner,
      repo: ghConfig.repo,
      issue_number: parseInt(ticketId, 10),
      body: comment,
    });
  }

  async updateState(
    ticketId: string,
    state: "open" | "closed",
    config: TicketProviderConfig,
  ): Promise<void> {
    const ghConfig = asGitHubConfig(config);
    const octokit = new Octokit({ auth: ghConfig.token });

    await octokit.issues.update({
      owner: ghConfig.owner,
      repo: ghConfig.repo,
      issue_number: parseInt(ticketId, 10),
      state,
    });
  }
}
