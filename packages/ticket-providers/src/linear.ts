import { LinearClient } from "@linear/sdk";
import {
  TicketSource,
  DEFAULT_TICKET_LABEL,
  DEFAULT_MAX_TICKET_PAGES,
  type Ticket,
  type TicketProviderConfig,
} from "@optio/shared";
import type { TicketProvider } from "./types.js";

export interface LinearProviderConfig extends TicketProviderConfig {
  apiKey: string;
  teamId?: string;
  projectId?: string;
  label?: string;
  /** Max pages to fetch (default: DEFAULT_MAX_TICKET_PAGES). Set to prevent runaway pagination. */
  maxPages?: number;
}

function asLinearConfig(config: TicketProviderConfig): LinearProviderConfig {
  const c = config as LinearProviderConfig;
  if (!c.apiKey) {
    throw new Error("Linear provider requires apiKey in config");
  }
  return c;
}

export class LinearTicketProvider implements TicketProvider {
  readonly source = TicketSource.LINEAR;

  async fetchActionableTickets(config: TicketProviderConfig): Promise<Ticket[]> {
    const linearConfig = asLinearConfig(config);
    const client = new LinearClient({ apiKey: linearConfig.apiKey });
    const label = linearConfig.label ?? DEFAULT_TICKET_LABEL;
    const maxPages = linearConfig.maxPages ?? DEFAULT_MAX_TICKET_PAGES;

    const filter = {
      labels: { name: { eq: label } },
      state: { type: { nin: ["completed", "canceled"] } },
      ...(linearConfig.teamId ? { team: { id: { eq: linearConfig.teamId } } } : {}),
    };

    const allTickets: Ticket[] = [];
    let afterCursor: string | undefined;
    let pageCount = 0;

    while (pageCount < maxPages) {
      const issues = await client.issues({
        filter,
        first: 50,
        ...(afterCursor ? { after: afterCursor } : {}),
      });

      for (const issue of issues.nodes) {
        allTickets.push({
          externalId: issue.identifier,
          source: TicketSource.LINEAR,
          title: issue.title,
          body: issue.description ?? "",
          url: issue.url,
          labels: [],
          assignee: undefined,
          repo: undefined,
          metadata: {
            id: issue.id,
            identifier: issue.identifier,
            priority: issue.priority,
            createdAt: issue.createdAt,
          },
        });
      }

      if (!issues.pageInfo.hasNextPage) break;
      afterCursor = issues.pageInfo.endCursor;
      pageCount++;
    }

    return allTickets;
  }

  private async findIssueByIdentifier(client: LinearClient, identifier: string) {
    // Search by the identifier string (e.g., "ENG-123")
    const results = await client.issueSearch({
      query: identifier,
      first: 5,
    });
    return results.nodes.find((issue) => issue.identifier === identifier) ?? null;
  }

  async addComment(ticketId: string, comment: string, config: TicketProviderConfig): Promise<void> {
    const linearConfig = asLinearConfig(config);
    const client = new LinearClient({ apiKey: linearConfig.apiKey });

    const issue = await this.findIssueByIdentifier(client, ticketId);
    if (!issue) return;

    await client.createComment({
      issueId: issue.id,
      body: comment,
    });
  }

  async updateState(
    ticketId: string,
    state: "open" | "closed",
    config: TicketProviderConfig,
  ): Promise<void> {
    const linearConfig = asLinearConfig(config);
    const client = new LinearClient({ apiKey: linearConfig.apiKey });

    const issue = await this.findIssueByIdentifier(client, ticketId);
    if (!issue) return;

    if (state === "closed") {
      // Find the "Done" state for the team
      const team = await issue.team;
      if (team) {
        const states = await team.states();
        const doneState = states.nodes.find((s) => s.type === "completed");
        if (doneState) {
          await issue.update({ stateId: doneState.id });
        }
      }
    }
  }
}
