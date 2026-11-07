import { Version2Client, Version3Client } from "jira.js";
import {
  TicketSource,
  DEFAULT_TICKET_LABEL,
  DEFAULT_MAX_TICKET_PAGES,
  type Ticket,
  type TicketComment,
  type TicketProviderConfig,
} from "@optio/shared";
import { guardedFetch } from "@optio/shared/outbound-http";
import axios, { type AxiosAdapter } from "axios";
import type { TicketProvider } from "./types.js";

/** Atlassian Cloud sites; anything else is self-hosted (Data Center / Server). */
const CLOUD_HOST = /\.(atlassian\.net|jira\.com|jira-dev\.com)$/i;

/** A REST v3 401/404 from a self-hosted host is almost always a Data Center
 * node behind a provider saved with the (default) Cloud flavor. */
function flavorHint(url: string, status: number): string {
  if (status !== 401 && status !== 404) return "";
  try {
    const { hostname, pathname } = new URL(url);
    if (!pathname.includes("/rest/api/3/") || CLOUD_HOST.test(hostname)) return "";
  } catch {
    return "";
  }
  return " (a self-hosted Jira Data Center or Server needs the provider's flavor set to data-center)";
}

/** Axios handles Jira's query/body serialization; the transport pins vetted DNS
 * answers and refuses redirects before sending the authenticated request. */
const guardedJiraAdapter: AxiosAdapter = async (config) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(config.headers.toJSON(true))) {
    if (value != null) headers.set(name, String(value));
  }
  const url = axios.getUri(config);
  const response = await guardedFetch(url, {
    method: config.method,
    headers,
    body: config.data,
    signal: config.signal as AbortSignal | undefined,
    timeoutMs: config.timeout || undefined,
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Jira API returned HTTP ${response.status}${flavorHint(url, response.status)}`);
  }
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    responseHeaders[name] = value;
  });
  return {
    data: await response.text(),
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    config,
  };
};

/**
 * Convert Atlassian Document Format (ADF) to plaintext.
 * Recursively extracts text from ADF nodes.
 */
function adfToPlaintext(adf: any): string {
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
 * Where the Jira runs. `cloud` is Atlassian Cloud: REST v3, email + API token.
 * `data-center` is a self-hosted Data Center (or Server) node: REST v2, signed
 * in with a username + password or a personal access token — it has no email
 * logins, no API tokens, no REST v3 and no `/search/jql`.
 */
export type JiraFlavor = "cloud" | "data-center";
/** How a Data Center provider signs in: `basic` (username + password) or `pat`. */
export type JiraAuthType = "basic" | "pat";

export interface JiraProviderConfig extends TicketProviderConfig {
  baseUrl: string;
  /** Unset means `cloud`: every provider saved before Data Center support. */
  flavor?: JiraFlavor;
  /** Data Center only; unset means `basic`. Cloud always uses email + API token. */
  authType?: JiraAuthType;
  /** Cloud: the Atlassian account's email. */
  email?: string;
  /** Data Center `basic`: the login name (falls back to `email` when unset). */
  username?: string;
  /** The credential (stored encrypted): the Cloud API token, the Data Center
   * password (`basic`) or the Data Center personal access token (`pat`). */
  apiToken: string;
  label?: string;
  projectKey?: string;
  maxPages?: number;
  doneStatusName?: string;
  todoStatusName?: string;
}

type Transition = { id?: string; to?: { name?: string } };

/** The few Jira calls the provider makes, over REST v3 (Cloud) or v2 (Data Center). */
interface JiraApi {
  /** One page of issues per iteration, at most `maxPages` requests. */
  searchPages(jql: string, fields: string[], maxPages: number): AsyncGenerator<any[]>;
  getIssueStatusCategory(key: string): Promise<string | undefined>;
  getComments(key: string): Promise<any[]>;
  addComment(key: string, text: string): Promise<void>;
  getTransitions(key: string): Promise<Transition[]>;
  doTransition(key: string, id: string): Promise<void>;
}

const PAGE_SIZE = 100;

/** Checks the config has what its flavor and auth type need. */
export function resolveJiraConfig(config: TicketProviderConfig): JiraProviderConfig & {
  flavor: JiraFlavor;
  authType: JiraAuthType;
} {
  const c = config as JiraProviderConfig;
  const flavor: JiraFlavor = c.flavor ?? "cloud";
  if (flavor !== "cloud" && flavor !== "data-center") {
    throw new Error(`JIRA provider flavor must be "cloud" or "data-center", not "${flavor}"`);
  }
  if (!c.baseUrl) throw new Error("JIRA provider requires baseUrl in config");
  if (flavor === "cloud") {
    if (c.authType && c.authType !== "basic") {
      throw new Error("JIRA Cloud signs in with email + API token only (authType basic)");
    }
    if (!c.email || !c.apiToken) {
      throw new Error("JIRA Cloud provider requires email and apiToken in config");
    }
    return { ...c, flavor, authType: "basic" };
  }
  const authType: JiraAuthType = c.authType ?? "basic";
  if (authType === "pat") {
    if (!c.apiToken) {
      throw new Error("JIRA Data Center provider requires a personal access token (apiToken)");
    }
  } else if (authType === "basic") {
    if (!(c.username || c.email) || !c.apiToken) {
      throw new Error("JIRA Data Center provider requires username and password (apiToken)");
    }
  } else {
    throw new Error(`JIRA Data Center authType must be "basic" or "pat", not "${authType}"`);
  }
  return { ...c, flavor, authType };
}

function cloudApi(c: JiraProviderConfig): JiraApi {
  const client = new Version3Client({
    host: c.baseUrl,
    baseRequestConfig: { adapter: guardedJiraAdapter },
    authentication: { basic: { email: c.email!, apiToken: c.apiToken } },
  });
  return {
    async *searchPages(jql, fields, maxPages) {
      let nextPageToken: string | undefined;
      for (let page = 1; page <= maxPages; page++) {
        const response = await client.issueSearch.searchForIssuesUsingJqlEnhancedSearch({
          jql,
          maxResults: PAGE_SIZE,
          nextPageToken,
          fields,
        });
        if (!response.issues || response.issues.length === 0) return;
        yield response.issues;
        if (!response.nextPageToken) return;
        nextPageToken = response.nextPageToken;
      }
    },
    async getIssueStatusCategory(key) {
      const issue = await client.issues.getIssue({ issueIdOrKey: key, fields: ["status"] });
      return (issue.fields as any)?.status?.statusCategory?.key;
    },
    async getComments(key) {
      const response = await client.issueComments.getComments({
        issueIdOrKey: key,
        maxResults: 30,
        orderBy: "-created",
      });
      return response.comments ?? [];
    },
    async addComment(key, text) {
      // REST v3 takes Atlassian Document Format.
      await client.issueComments.addComment({
        issueIdOrKey: key,
        comment: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        },
      } as any);
    },
    async getTransitions(key) {
      return (await client.issues.getTransitions({ issueIdOrKey: key })).transitions ?? [];
    },
    async doTransition(key, id) {
      await client.issues.doTransition({ issueIdOrKey: key, transition: { id } });
    },
  };
}

function dataCenterApi(c: JiraProviderConfig & { authType: JiraAuthType }): JiraApi {
  // jira.js only signs Cloud-style (email + API token) or OAuth 2.0, so Data
  // Center's header is set here and the SDK is given no `authentication`.
  const authorization =
    c.authType === "pat"
      ? `Bearer ${c.apiToken}`
      : `Basic ${Buffer.from(`${c.username || c.email}:${c.apiToken}`, "utf8").toString("base64")}`;
  const client = new Version2Client({
    host: c.baseUrl,
    baseRequestConfig: { adapter: guardedJiraAdapter, headers: { Authorization: authorization } },
  });
  return {
    async *searchPages(jql, fields, maxPages) {
      // REST v2 pages by offset. A node may cap maxResults below what was
      // asked (jira.search.views.default.max), so step by what came back.
      let startAt = 0;
      for (let page = 1; page <= maxPages; page++) {
        const response = await client.issueSearch.searchForIssuesUsingJql({
          jql,
          startAt,
          maxResults: PAGE_SIZE,
          fields,
        });
        const issues = response.issues ?? [];
        if (issues.length === 0) return;
        yield issues;
        startAt += issues.length;
        if (response.total !== undefined && startAt >= response.total) return;
      }
    },
    async getIssueStatusCategory(key) {
      const issue = await client.issues.getIssue({ issueIdOrKey: key, fields: ["status"] });
      return (issue.fields as any)?.status?.statusCategory?.key;
    },
    async getComments(key) {
      const response = await client.issueComments.getComments({
        issueIdOrKey: key,
        maxResults: 30,
        orderBy: "-created",
      });
      return response.comments ?? [];
    },
    async addComment(key, text) {
      // REST v2 takes the body as a (wiki markup) string.
      await client.issueComments.addComment({ issueIdOrKey: key, comment: text });
    },
    async getTransitions(key) {
      return (await client.issues.getTransitions({ issueIdOrKey: key })).transitions ?? [];
    },
    async doTransition(key, id) {
      await client.issues.doTransition({ issueIdOrKey: key, transition: { id } });
    },
  };
}

/** The config, checked, and the API for its flavor. */
function jiraFor(config: TicketProviderConfig) {
  const c = resolveJiraConfig(config);
  return { config: c, api: c.flavor === "data-center" ? dataCenterApi(c) : cloudApi(c) };
}

export class JiraTicketProvider implements TicketProvider {
  readonly source = TicketSource.JIRA;

  async fetchActionableTickets(config: TicketProviderConfig): Promise<Ticket[]> {
    const { config: jiraConfig, api } = jiraFor(config);

    const label = jiraConfig.label ?? DEFAULT_TICKET_LABEL;
    const maxPages = jiraConfig.maxPages ?? DEFAULT_MAX_TICKET_PAGES;

    const jqlParts: string[] = [`labels = "${label}"`, `status != Done AND status != Closed`];
    if (jiraConfig.projectKey) {
      jqlParts.push(`project = "${jiraConfig.projectKey}"`);
    }
    const jql = jqlParts.join(" AND ");
    const fields = [
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
    ];

    const allTickets: Ticket[] = [];
    for await (const issues of api.searchPages(jql, fields, maxPages)) {
      for (const issue of issues) {
        const fields = issue.fields;
        const attachments =
          fields.attachment?.map((att: any) => ({
            filename: att.filename,
            url: att.content,
            mimeType: att.mimeType,
          })) ?? [];

        // Cloud (v3) descriptions are ADF; Data Center (v2) ones are wiki-markup strings.
        const description = fields.description
          ? typeof fields.description === "string"
            ? fields.description
            : adfToPlaintext(fields.description)
          : "";

        allTickets.push({
          externalId: issue.key,
          source: TicketSource.JIRA,
          title: fields.summary,
          body: description,
          url: `${jiraConfig.baseUrl}/browse/${issue.key}`,
          labels: fields.labels ?? [],
          assignee: fields.assignee?.displayName,
          // Extract target repo from a "repo:<owner/repo>" Jira label (e.g. "repo:acme/backend").
          // Accepts full URLs, "owner/repo" paths, or bare repo names for suffix matching.
          repo: (fields.labels ?? [])
            .find((l: string) => l.startsWith("repo:"))
            ?.slice(5)
            .trim(),
          attachments: attachments.length > 0 ? attachments : undefined,
          metadata: {
            key: issue.key,
            status: fields.status.name,
            priority: fields.priority?.name,
            created: fields.created,
            updated: fields.updated,
            projectKey: fields.project.key,
          },
        });
      }
    }

    return allTickets;
  }

  async fetchTicketState(
    ticketId: string,
    config: TicketProviderConfig,
  ): Promise<"open" | "in_progress" | "done" | "canceled"> {
    const category = await jiraFor(config).api.getIssueStatusCategory(ticketId);
    if (category === "done") return "done";
    if (category === "indeterminate") return "in_progress";
    return "open";
  }

  async fetchTicketComments(
    ticketId: string,
    config: TicketProviderConfig,
  ): Promise<TicketComment[]> {
    const comments = await jiraFor(config).api.getComments(ticketId);
    return comments.map((c: any) => ({
      author: c.author?.displayName ?? "unknown",
      body: typeof c.body === "string" ? c.body : adfToPlaintext(c.body),
      createdAt: c.created ?? "",
    }));
  }

  async addComment(ticketId: string, comment: string, config: TicketProviderConfig): Promise<void> {
    await jiraFor(config).api.addComment(ticketId, comment);
  }

  async updateState(
    ticketId: string,
    state: "open" | "closed",
    config: TicketProviderConfig,
  ): Promise<void> {
    const { config: jiraConfig, api } = jiraFor(config);

    const targetStatusName =
      state === "closed"
        ? (jiraConfig.doneStatusName ?? "Done")
        : (jiraConfig.todoStatusName ?? "To Do");

    const transitions = await api.getTransitions(ticketId);
    const targetTransition = transitions.find((t) => t.to?.name === targetStatusName);

    if (!targetTransition?.id) {
      console.warn(
        `JIRA: No transition found to status "${targetStatusName}" for issue ${ticketId}. Available transitions: ${transitions.map((t) => t.to?.name).join(", ")}`,
      );
      return;
    }

    await api.doTransition(ticketId, targetTransition.id);
  }
}
