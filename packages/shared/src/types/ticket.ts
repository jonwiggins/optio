export enum TicketSource {
  GITHUB = "github",
  LINEAR = "linear",
}

export interface Ticket {
  externalId: string;
  source: TicketSource;
  title: string;
  body: string;
  url: string;
  labels: string[];
  assignee?: string;
  repo?: string;
  metadata: Record<string, unknown>;
}

export interface TicketProviderConfig {
  [key: string]: unknown;
}
