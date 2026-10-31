import type {
  Ticket,
  TicketComment,
  TicketConnectionTest,
  TicketSource,
  TicketProviderConfig,
} from "@optio/shared";

export interface TicketProvider {
  readonly source: TicketSource;

  /** Check the credentials reach the service; never throws for a bad config, it reports it */
  testConnection?(config: TicketProviderConfig): Promise<TicketConnectionTest>;

  /** Fetch tickets that match the configured filters */
  fetchActionableTickets(config: TicketProviderConfig): Promise<Ticket[]>;

  /** Fetch comments for a single ticket */
  fetchTicketComments(ticketId: string, config: TicketProviderConfig): Promise<TicketComment[]>;

  /** Post a comment on a ticket */
  addComment(ticketId: string, comment: string, config: TicketProviderConfig): Promise<void>;

  /**
   * Where one ticket stands, for a badge: open / in progress / done /
   * canceled. Providers whose API has no cheap single-ticket read leave it out.
   */
  fetchTicketState?(
    ticketId: string,
    config: TicketProviderConfig,
  ): Promise<"open" | "in_progress" | "done" | "canceled">;

  /** Update ticket state */
  updateState(
    ticketId: string,
    state: "open" | "closed",
    config: TicketProviderConfig,
  ): Promise<void>;
}
