export enum TicketSource {
  GITHUB = "github",
  GITLAB = "gitlab",
  LINEAR = "linear",
  JIRA = "jira",
  NOTION = "notion",
}

export interface TicketComment {
  author: string;
  body: string;
  createdAt: string;
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
  attachments?: Array<{ filename: string; url: string; mimeType?: string }>;
  comments?: TicketComment[];
  metadata: Record<string, unknown>;
}

export interface TicketProviderConfig {
  [key: string]: unknown;
}

/** What a provider's connection test (the "Test" button) found. */
export interface TicketConnectionTest {
  ok: boolean;
  /** Why not, for people: never a token or a response body. */
  error?: string;
  serverTitle?: string;
  version?: string;
  /** What the server says it is (`Cloud`, `Server`, `DataCenter`). */
  deploymentType?: string;
  /** Display name of the account the credentials belong to. */
  user?: string;
}
