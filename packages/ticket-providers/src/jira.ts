import { Version3Client } from "jira.js";
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

/** Axios handles Jira's query/body serialization; the transport pins vetted DNS
 * answers and refuses redirects before sending the authenticated request. */
const guardedJiraAdapter: AxiosAdapter = async (config) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(config.headers.toJSON(true))) {
    if (value != null) headers.set(name, String(value));
  }
  const response = await guardedFetch(axios.getUri(config), {
    method: config.method,
    headers,
    body: config.data,
    signal: config.signal as AbortSignal | undefined,
    timeoutMs: config.timeout || undefined,
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Jira API returned HTTP ${response.status}`);
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

export interface JiraProviderConfig extends TicketProviderConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  label?: string;
  projectKey?: string;
  maxPages?: number;
  doneStatusName?: string;
  todoStatusName?: string;
}

function asJiraConfig(config: TicketProviderConfig): JiraProviderConfig {
  const c = config as JiraProviderConfig;
  if (!c.baseUrl || !c.email || !c.apiToken) {
    throw new Error("JIRA provider requires baseUrl, email, and apiToken in config");
  }
  return c;
}

export class JiraTicketProvider implements TicketProvider {
  readonly source = TicketSource.JIRA;

  async fetchActionableTickets(config: TicketProviderConfig): Promise<Ticket[]> {
    const jiraConfig = asJiraConfig(config);
    const client = new Version3Client({
      host: jiraConfig.baseUrl,
      baseRequestConfig: { adapter: guardedJiraAdapter },
      authentication: {
        basic: {
          email: jiraConfig.email,
          apiToken: jiraConfig.apiToken,
        },
      },
    });

    const label = jiraConfig.label ?? DEFAULT_TICKET_LABEL;
    const maxPages = jiraConfig.maxPages ?? DEFAULT_MAX_TICKET_PAGES;

    const jqlParts: string[] = [`labels = "${label}"`, `status != Done AND status != Closed`];
    if (jiraConfig.projectKey) {
      jqlParts.push(`project = "${jiraConfig.projectKey}"`);
    }
    const jql = jqlParts.join(" AND ");

    const allTickets: Ticket[] = [];
    const maxResults = 100;
    let pageCount = 1;
    let nextPageToken: string | undefined;

    while (pageCount <= maxPages) {
      const response = await client.issueSearch.searchForIssuesUsingJqlEnhancedSearch({
        jql,
        maxResults,
        nextPageToken,
        fields: [
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
        ],
      });

      if (!response.issues || response.issues.length === 0) break;

      for (const issue of response.issues) {
        const fields = issue.fields;
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

      if (!response.nextPageToken) break;

      nextPageToken = response.nextPageToken;
      pageCount++;
    }

    return allTickets;
  }

  async fetchTicketState(
    ticketId: string,
    config: TicketProviderConfig,
  ): Promise<"open" | "in_progress" | "done" | "canceled"> {
    const jiraConfig = asJiraConfig(config);
    const client = new Version3Client({
      host: jiraConfig.baseUrl,
      baseRequestConfig: { adapter: guardedJiraAdapter },
      authentication: {
        basic: { email: jiraConfig.email, apiToken: jiraConfig.apiToken },
      },
    });
    const issue = await client.issues.getIssue({ issueIdOrKey: ticketId, fields: ["status"] });
    const category = (issue.fields as any)?.status?.statusCategory?.key;
    if (category === "done") return "done";
    if (category === "indeterminate") return "in_progress";
    return "open";
  }

  async fetchTicketComments(
    ticketId: string,
    config: TicketProviderConfig,
  ): Promise<TicketComment[]> {
    const jiraConfig = asJiraConfig(config);
    const client = new Version3Client({
      host: jiraConfig.baseUrl,
      baseRequestConfig: { adapter: guardedJiraAdapter },
      authentication: {
        basic: {
          email: jiraConfig.email,
          apiToken: jiraConfig.apiToken,
        },
      },
    });

    const response = await client.issueComments.getComments({
      issueIdOrKey: ticketId,
      maxResults: 30,
      orderBy: "-created",
    });

    return (response.comments ?? []).map((c: any) => ({
      author: c.author?.displayName ?? "unknown",
      body: typeof c.body === "string" ? c.body : adfToPlaintext(c.body),
      createdAt: c.created ?? "",
    }));
  }

  async addComment(ticketId: string, comment: string, config: TicketProviderConfig): Promise<void> {
    const jiraConfig = asJiraConfig(config);
    const client = new Version3Client({
      host: jiraConfig.baseUrl,
      baseRequestConfig: { adapter: guardedJiraAdapter },
      authentication: {
        basic: {
          email: jiraConfig.email,
          apiToken: jiraConfig.apiToken,
        },
      },
    });

    await client.issueComments.addComment({
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
    const client = new Version3Client({
      host: jiraConfig.baseUrl,
      baseRequestConfig: { adapter: guardedJiraAdapter },
      authentication: {
        basic: {
          email: jiraConfig.email,
          apiToken: jiraConfig.apiToken,
        },
      },
    });

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
