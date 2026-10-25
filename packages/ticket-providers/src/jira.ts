import { Agent as HttpsAgent } from "node:https";
import { Version2Client, Version3Client } from "jira.js";
import {
  TicketSource,
  DEFAULT_TICKET_LABEL,
  DEFAULT_MAX_TICKET_PAGES,
  type Ticket,
  type TicketComment,
  type TicketConnectionTest,
  type TicketProviderConfig,
} from "@optio/shared";
import { assertSsrfSafe } from "@optio/shared/ssrf";
import type { TicketProvider } from "./types.js";

/**
 * Convert Atlassian Document Format (ADF) to plaintext.
 * Recursively extracts text from ADF nodes.
 */
export function adfToPlaintext(adf: any): string {
  if (!adf || typeof adf !== "object") return "";

  let text = "";

  if (adf.type === "text" && adf.text) {
    return adf.text;
  }

  if (Array.isArray(adf.content)) {
    for (const node of adf.content) {
      text += adfToPlaintext(node);
      // Add newlines after paragraphs, headings, etc.
      if (node.type === "paragraph" || node.type === "heading" || node.type === "codeBlock") {
        text += "\n";
      }
    }
  }

  return text;
}

/**
 * Jira Cloud (`<site>.atlassian.net`, REST v3, ADF bodies) or a self-hosted
 * Server / Data Center (REST v2 under `<baseUrl>/rest/api/2`, plain-string
 * and wiki-markup bodies).
 */
export type JiraDeployment = "cloud" | "server";

/**
 * How the credential is sent. `basic`: the email (Cloud) or username (Server)
 * with `apiToken` as the password. `pat`: a Server / Data Center personal
 * access token (Jira 8.14+) sent as `Authorization: Bearer`.
 */
export type JiraAuthType = "basic" | "pat";

export interface JiraProviderConfig extends TicketProviderConfig {
  /** The site or server, context path included (`https://jira.example.com/jira`). */
  baseUrl: string;
  /** Inferred when absent: `cloud` with an `email` and no `authType`, else `server`. */
  deployment?: JiraDeployment;
  /** Defaults to `basic` on Cloud and `pat` on Server. */
  authType?: JiraAuthType;
  /** Cloud: the account's email. */
  email?: string;
  /** Server with basic auth: the account's username. */
  username?: string;
  /** The Cloud API token, the Server PAT, or (Server, basic) the password. */
  apiToken: string;
  /**
   * PEM bundle of the CA behind a Server's certificate, for a connection
   * that cannot rely on NODE_EXTRA_CA_CERTS. It replaces the trust store for
   * this provider's requests.
   */
  caPem?: string | null;
  label?: string;
  projectKey?: string;
  /** Extra JQL ANDed into the search, e.g. `issuetype = Bug` (no ORDER BY). */
  jql?: string | null;
  maxPages?: number;
  doneStatusName?: string;
  todoStatusName?: string;
}

export interface ResolvedJiraAuth {
  deployment: JiraDeployment;
  authType: JiraAuthType;
}

/** The deployment and auth a config means once the defaults are applied. */
export function resolveJiraAuth(
  config: Pick<JiraProviderConfig, "deployment" | "authType" | "email">,
): ResolvedJiraAuth {
  const deployment = config.deployment ?? (config.email && !config.authType ? "cloud" : "server");
  const authType = config.authType ?? (deployment === "cloud" ? "basic" : "pat");
  return { deployment, authType };
}

export interface JiraConfigProblem {
  field: "baseUrl" | "email" | "username" | "apiToken" | "authType";
  message: string;
}

/**
 * The first thing wrong with a config, naming the field: Cloud needs
 * `baseUrl` + `email` + `apiToken`; Server with a PAT needs `baseUrl` +
 * `apiToken`; Server with basic auth needs `baseUrl` + `username` +
 * `apiToken`. Shared with the API's request schema.
 */
export function jiraConfigProblem(config: Partial<JiraProviderConfig>): JiraConfigProblem | null {
  if (!config.baseUrl) {
    return { field: "baseUrl", message: "JIRA provider requires baseUrl in config" };
  }
  const { deployment, authType } = resolveJiraAuth(config);
  if (deployment === "cloud") {
    if (authType !== "basic") {
      return {
        field: "authType",
        message:
          'JIRA Cloud uses basic auth (email + apiToken); authType "pat" is for Jira Server / Data Center',
      };
    }
    if (!config.email) {
      return { field: "email", message: "JIRA Cloud provider requires email in config" };
    }
    if (!config.apiToken) {
      return { field: "apiToken", message: "JIRA Cloud provider requires apiToken in config" };
    }
    return null;
  }
  if (authType === "basic") {
    if (!config.username) {
      return {
        field: "username",
        message: "JIRA Server provider with basic auth requires username in config",
      };
    }
    if (!config.apiToken) {
      return {
        field: "apiToken",
        message: "JIRA Server provider with basic auth requires apiToken (the password) in config",
      };
    }
    return null;
  }
  if (!config.apiToken) {
    return {
      field: "apiToken",
      message: "JIRA Server provider requires apiToken (a personal access token) in config",
    };
  }
  return null;
}

export function asJiraConfig(config: TicketProviderConfig): JiraProviderConfig {
  const c = config as JiraProviderConfig;
  const problem = jiraConfigProblem(c);
  if (problem) throw new Error(problem.message);
  // A trailing slash would double up in `<baseUrl>/browse/<key>`; axios joins
  // the REST paths either way.
  return { ...c, baseUrl: c.baseUrl.replace(/\/+$/, "") };
}

type JiraClientOptions = ConstructorParameters<typeof Version3Client>[0];

/** The jira.js options for a config: host, how to authenticate, and the CA. */
function clientOptions(c: JiraProviderConfig): JiraClientOptions {
  const { deployment, authType } = resolveJiraAuth(c);
  const options: JiraClientOptions = {
    host: c.baseUrl,
    authentication:
      authType === "pat"
        ? // jira.js sends an OAuth2 access token as `Authorization: Bearer`,
          // which is exactly how a Server / Data Center PAT travels.
          { oauth2: { accessToken: c.apiToken } }
        : {
            basic: {
              email: (deployment === "cloud" ? c.email : c.username) as string,
              apiToken: c.apiToken,
            },
          },
  };
  if (c.caPem?.trim()) {
    options.baseRequestConfig = { httpsAgent: new HttpsAgent({ ca: c.caPem }) };
  }
  return options;
}

export function cloudClient(c: JiraProviderConfig): Version3Client {
  return new Version3Client(clientOptions(c));
}

export function serverClient(c: JiraProviderConfig): Version2Client {
  return new Version2Client(clientOptions(c));
}

/** What comments, transitions and the connection test use; the same on both APIs. */
interface JiraCommonClient {
  serverInfo: {
    getServerInfo(): Promise<{ serverTitle?: string; version?: string; deploymentType?: string }>;
  };
  myself: {
    getCurrentUser(): Promise<{ displayName?: string; name?: string; emailAddress?: string }>;
  };
  issueComments: {
    getComments(parameters: {
      issueIdOrKey: string;
      maxResults?: number;
      orderBy?: string;
    }): Promise<{ comments?: unknown[] }>;
  };
  issues: {
    getTransitions(parameters: {
      issueIdOrKey: string;
    }): Promise<{ transitions?: Array<{ id?: string; to?: { name?: string } }> }>;
    doTransition(parameters: {
      issueIdOrKey: string;
      transition: { id?: string };
    }): Promise<unknown>;
  };
}

function anyClient(c: JiraProviderConfig): JiraCommonClient {
  return resolveJiraAuth(c).deployment === "server" ? serverClient(c) : cloudClient(c);
}

const SEARCH_FIELDS = [
  "summary",
  "description",
  "status",
  "priority",
  "assignee",
  "created",
  "updated",
  "labels",
  "project",
  "attachment",
  // Who asked, for the commits' Co-authored-by (work-traceability.ts).
  "reporter",
];

/**
 * The search. Cloud keeps its status clause; a Server's status names are its
 * own (`status != Closed` is a JQL error on an instance without that
 * status), so there the built-in category is excluded instead.
 */
function buildJql(c: JiraProviderConfig, deployment: JiraDeployment): string {
  const label = c.label ?? DEFAULT_TICKET_LABEL;
  const jqlParts: string[] = [
    `labels = "${label}"`,
    deployment === "server" ? "statusCategory != Done" : "status != Done AND status != Closed",
  ];
  if (c.projectKey) {
    jqlParts.push(`project = "${c.projectKey}"`);
  }
  const extra = c.jql?.trim();
  if (extra) {
    jqlParts.push(`(${extra})`);
  }
  return jqlParts.join(" AND ");
}

/**
 * One search hit as a Ticket. A Server's description is a plain (wiki
 * markup) string where Cloud's is ADF, and a Server may leave out fields
 * such as labels, assignee or priority.
 */
function toTicket(issue: any, baseUrl: string): Ticket {
  const fields = issue.fields ?? {};
  const labels: string[] = Array.isArray(fields.labels) ? fields.labels : [];
  const attachments =
    fields.attachment?.map((att: any) => ({
      filename: att.filename,
      url: att.content,
      mimeType: att.mimeType,
    })) ?? [];

  // Convert ADF description to plaintext
  const description = fields.description
    ? typeof fields.description === "string"
      ? fields.description
      : adfToPlaintext(fields.description)
    : "";

  return {
    externalId: issue.key,
    source: TicketSource.JIRA,
    title: fields.summary ?? "",
    body: description,
    url: `${baseUrl}/browse/${issue.key}`,
    labels,
    assignee: fields.assignee?.displayName,
    // Extract target repo from a "repo:<owner/repo>" Jira label (e.g. "repo:acme/backend").
    // Accepts full URLs, "owner/repo" paths, or bare repo names for suffix matching.
    repo: labels
      .find((l: string) => l.startsWith("repo:"))
      ?.slice(5)
      .trim(),
    attachments: attachments.length > 0 ? attachments : undefined,
    metadata: {
      key: issue.key,
      status: fields.status?.name,
      priority: fields.priority?.name,
      created: fields.created,
      updated: fields.updated,
      projectKey: fields.project?.key,
      // Who asked (Server hides the email when the server says so).
      reporter: fields.reporter
        ? { name: fields.reporter.displayName ?? null, email: fields.reporter.emailAddress ?? null }
        : undefined,
    },
  };
}

const TLS_ERROR_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * A readable reason for a failed request: the status or the socket error
 * class, never the response body (a Jira error page) or the credential.
 */
export function describeJiraError(err: unknown): string {
  const e = err as {
    status?: unknown;
    statusText?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: { code?: unknown };
  };
  const status = typeof e?.status === "number" ? e.status : undefined;
  if (status === 401)
    return "Authentication failed (401): check the token, or the username and password";
  if (status === 403) {
    return "Forbidden (403): the account may not use the REST API, or Jira wants a CAPTCHA after failed logins";
  }
  if (status === 404) {
    return "Not found (404): check the base URL, including the context path (https://jira.example.com/jira)";
  }
  if (status !== undefined) {
    const text = typeof e.statusText === "string" && e.statusText ? ` ${e.statusText}` : "";
    return `Jira answered HTTP ${status}${text}`;
  }
  const code =
    typeof e?.code === "string"
      ? e.code
      : typeof e?.cause?.code === "string"
        ? e.cause.code
        : undefined;
  if (code && TLS_ERROR_CODES.has(code)) {
    return `TLS error ${code}: the Jira certificate is not trusted; set caPem or NODE_EXTRA_CA_CERTS`;
  }
  const message = typeof e?.message === "string" && e.message ? e.message : String(err);
  return code ? `${code}: ${message}` : message;
}

export class JiraTicketProvider implements TicketProvider {
  readonly source = TicketSource.JIRA;

  /**
   * `serverInfo` (anonymous on most servers: the URL, context path and CA
   * are right) then `myself` (the credential is). Both APIs serve them.
   */
  async testConnection(config: TicketProviderConfig): Promise<TicketConnectionTest> {
    let jiraConfig: JiraProviderConfig;
    try {
      jiraConfig = asJiraConfig(config);
      await assertSsrfSafe(jiraConfig.baseUrl);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const client = anyClient(jiraConfig);
    try {
      const info = await client.serverInfo.getServerInfo();
      const me = await client.myself.getCurrentUser();
      return {
        ok: true,
        serverTitle: info.serverTitle,
        version: info.version,
        deploymentType: info.deploymentType,
        user: me.displayName ?? me.name ?? me.emailAddress,
      };
    } catch (err) {
      return { ok: false, error: describeJiraError(err) };
    }
  }

  async fetchActionableTickets(config: TicketProviderConfig): Promise<Ticket[]> {
    const jiraConfig = asJiraConfig(config);
    await assertSsrfSafe(jiraConfig.baseUrl);
    const { deployment } = resolveJiraAuth(jiraConfig);
    const jql = buildJql(jiraConfig, deployment);
    const maxPages = jiraConfig.maxPages ?? DEFAULT_MAX_TICKET_PAGES;
    const maxResults = 100;

    if (deployment === "server") {
      return this.searchServer(
        serverClient(jiraConfig),
        jiraConfig.baseUrl,
        jql,
        maxPages,
        maxResults,
      );
    }

    const client = cloudClient(jiraConfig);
    const allTickets: Ticket[] = [];
    let pageCount = 1;
    let nextPageToken: string | undefined;

    while (pageCount <= maxPages) {
      const response = await client.issueSearch.searchForIssuesUsingJqlEnhancedSearch({
        jql,
        maxResults,
        nextPageToken,
        fields: SEARCH_FIELDS,
      });

      if (!response.issues || response.issues.length === 0) break;

      for (const issue of response.issues) {
        allTickets.push(toTicket(issue, jiraConfig.baseUrl));
      }

      if (!response.nextPageToken) break;

      nextPageToken = response.nextPageToken;
      pageCount++;
    }

    return allTickets;
  }

  /** `/rest/api/2/search`: offset paging by `startAt`, `total` says when to stop. */
  private async searchServer(
    client: Version2Client,
    baseUrl: string,
    jql: string,
    maxPages: number,
    maxResults: number,
  ): Promise<Ticket[]> {
    const allTickets: Ticket[] = [];
    let pageCount = 1;
    let startAt = 0;

    while (pageCount <= maxPages) {
      const response = await client.issueSearch.searchForIssuesUsingJql({
        jql,
        startAt,
        maxResults,
        fields: SEARCH_FIELDS,
      });

      const issues = response.issues ?? [];
      if (issues.length === 0) break;

      for (const issue of issues) {
        allTickets.push(toTicket(issue, baseUrl));
      }

      startAt += issues.length;
      // Without a total (it is always sent, but be safe) a short page is the last.
      const done =
        typeof response.total === "number" ? startAt >= response.total : issues.length < maxResults;
      if (done) break;
      pageCount++;
    }

    return allTickets;
  }

  async fetchTicketComments(
    ticketId: string,
    config: TicketProviderConfig,
  ): Promise<TicketComment[]> {
    const jiraConfig = asJiraConfig(config);
    await assertSsrfSafe(jiraConfig.baseUrl);
    const client = anyClient(jiraConfig);

    const response = await client.issueComments.getComments({
      issueIdOrKey: ticketId,
      maxResults: 30,
      orderBy: "-created",
    });

    // v2 answers with `body` as a string, v3 as ADF.
    return (response.comments ?? []).map((c: any) => ({
      author: c.author?.displayName ?? "unknown",
      body: typeof c.body === "string" ? c.body : adfToPlaintext(c.body),
      createdAt: c.created ?? "",
    }));
  }

  async addComment(ticketId: string, comment: string, config: TicketProviderConfig): Promise<void> {
    const jiraConfig = asJiraConfig(config);
    await assertSsrfSafe(jiraConfig.baseUrl);

    if (resolveJiraAuth(jiraConfig).deployment === "server") {
      // jira.js' v2 wrapper takes the plain-string body as `comment` and
      // sends it as `body`, which is what Server / Data Center expects.
      await serverClient(jiraConfig).issueComments.addComment({
        issueIdOrKey: ticketId,
        comment,
      });
      return;
    }

    await cloudClient(jiraConfig).issueComments.addComment({
      issueIdOrKey: ticketId,
      comment: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: comment,
              },
            ],
          },
        ],
      },
    } as any);
  }

  async updateState(
    ticketId: string,
    state: "open" | "closed",
    config: TicketProviderConfig,
  ): Promise<void> {
    const jiraConfig = asJiraConfig(config);
    await assertSsrfSafe(jiraConfig.baseUrl);
    const client = anyClient(jiraConfig);

    const targetStatusName =
      state === "closed"
        ? (jiraConfig.doneStatusName ?? "Done")
        : (jiraConfig.todoStatusName ?? "To Do");

    const transitionsResponse = await client.issues.getTransitions({
      issueIdOrKey: ticketId,
    });

    const targetTransition = transitionsResponse.transitions?.find(
      (t: any) => t.to?.name === targetStatusName,
    );

    if (!targetTransition) {
      console.warn(
        `JIRA: No transition found to status "${targetStatusName}" for issue ${ticketId}. Available transitions: ${transitionsResponse.transitions?.map((t: any) => t.to?.name).join(", ")}`,
      );
      return;
    }

    await client.issues.doTransition({
      issueIdOrKey: ticketId,
      transition: {
        id: targetTransition.id,
      },
    });
  }
}
