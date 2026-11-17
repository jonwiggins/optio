import { Client } from "@notionhq/client";
import {
  TicketSource,
  DEFAULT_TICKET_LABEL,
  DEFAULT_MAX_TICKET_PAGES,
  type Ticket,
  type TicketComment,
  type TicketProviderConfig,
} from "@optio/shared";
import type { TicketProvider } from "./types.js";

/**
 * Convert Notion rich text array to plaintext.
 */
function richTextToPlaintext(richText: Array<{ plain_text: string }>): string {
  return richText.map((rt) => rt.plain_text).join("");
}

/**
 * Extract plaintext from Notion block children (page body content).
 */
function blocksToPlaintext(blocks: any[]): string {
  const parts: string[] = [];

  for (const block of blocks) {
    const type = block.type;
    const data = block[type];

    if (data?.rich_text) {
      parts.push(richTextToPlaintext(data.rich_text));
    } else if (type === "divider") {
      parts.push("---");
    }
  }

  return parts.join("\n");
}

export interface NotionProviderConfig extends TicketProviderConfig {
  apiKey: string;
  databaseId: string;
  label?: string;
  statusProperty?: string;
  doneValue?: string;
  titleProperty?: string;
  maxPages?: number;
}

export function asNotionConfig(config: TicketProviderConfig): NotionProviderConfig {
  const c = config as NotionProviderConfig;
  if (!c.apiKey || !c.databaseId) {
    throw new Error("Notion provider requires apiKey and databaseId in config");
  }
  return c;
}

export class NotionTicketProvider implements TicketProvider {
  readonly source = TicketSource.NOTION;

  async fetchActionableTickets(config: TicketProviderConfig): Promise<Ticket[]> {
    const notionConfig = asNotionConfig(config);
    const client = new Client({ auth: notionConfig.apiKey });
    const label = notionConfig.label ?? DEFAULT_TICKET_LABEL;
    const maxPages = notionConfig.maxPages ?? DEFAULT_MAX_TICKET_PAGES;
    const statusProperty = notionConfig.statusProperty ?? "Status";
    const doneValue = notionConfig.doneValue ?? "Done";
    const titleProperty = notionConfig.titleProperty ?? "Name";

    const allTickets: Ticket[] = [];
    let startCursor: string | undefined;
    let pageCount = 0;

    while (pageCount < maxPages) {
      const response = await client.databases.query({
        database_id: notionConfig.databaseId,
        filter: {
          and: [
            {
              property: statusProperty,
              status: {
                does_not_equal: doneValue,
              },
            },
          ],
        },
        ...(startCursor ? { start_cursor: startCursor } : {}),
        page_size: 100,
      });

      for (const page of response.results) {
        if (!("properties" in page)) continue;

        const properties = page.properties as Record<string, any>;

        // Extract title
        const titleProp = properties[titleProperty];
        const title = titleProp?.title ? richTextToPlaintext(titleProp.title) : "";

        // Extract labels from multi-select Tags/Labels property
        const labels: string[] = [];
        for (const [, prop] of Object.entries(properties)) {
          const p = prop;
          if (p.type === "multi_select") {
            for (const option of p.multi_select) {
              labels.push(option.name);
            }
          }
        }

        // Filter by label if configured
        if (label && !labels.some((l) => l.toLowerCase() === label.toLowerCase())) {
          continue;
        }

        // Extract status
        const statusProp = properties[statusProperty];
        const status = statusProp?.status?.name ?? statusProp?.select?.name ?? "";

        // Extract assignee from People property
        let assignee: string | undefined;
        for (const [, prop] of Object.entries(properties)) {
          const p = prop;
          if (p.type === "people" && p.people?.length > 0) {
            assignee = p.people[0].name ?? p.people[0].id;
            break;
          }
        }

        // Fetch page content blocks for body
        let body = "";
        try {
          const blocks = await client.blocks.children.list({
            block_id: page.id,
            page_size: 100,
          });
          body = blocksToPlaintext(blocks.results);
        } catch {
          // If we can't read blocks, use empty body
        }

        allTickets.push({
          externalId: page.id,
          source: TicketSource.NOTION,
          title,
          body,
          url: (page as any).url ?? `https://notion.so/${page.id.replace(/-/g, "")}`,
          labels,
          assignee,
          repo: undefined,
          metadata: {
            pageId: page.id,
            status,
            createdTime: (page as any).created_time,
            lastEditedTime: (page as any).last_edited_time,
          },
        });
      }

      if (!response.has_more || !response.next_cursor) break;
      startCursor = response.next_cursor;
      pageCount++;
    }

    return allTickets;
  }

  async fetchTicketComments(
    ticketId: string,
    config: TicketProviderConfig,
  ): Promise<TicketComment[]> {
    const notionConfig = asNotionConfig(config);
    const client = new Client({ auth: notionConfig.apiKey });

    const response = await client.comments.list({
      block_id: ticketId,
      page_size: 100,
    });

    return response.results.map((comment: any) => ({
      author: comment.created_by?.name ?? comment.created_by?.id ?? "unknown",
      body: richTextToPlaintext(comment.rich_text ?? []),
      createdAt: comment.created_time ?? "",
    }));
  }

  async addComment(ticketId: string, comment: string, config: TicketProviderConfig): Promise<void> {
    const notionConfig = asNotionConfig(config);
    const client = new Client({ auth: notionConfig.apiKey });

    await client.comments.create({
      parent: { page_id: ticketId },
      rich_text: [
        {
          type: "text",
          text: { content: comment },
        },
      ],
    });
  }

  async updateState(
    ticketId: string,
    state: "open" | "closed",
    config: TicketProviderConfig,
  ): Promise<void> {
    const notionConfig = asNotionConfig(config);
    const client = new Client({ auth: notionConfig.apiKey });
    const statusProperty = notionConfig.statusProperty ?? "Status";
    const doneValue = notionConfig.doneValue ?? "Done";

    const newStatus = state === "closed" ? doneValue : "Not started";

    await client.pages.update({
      page_id: ticketId,
      properties: {
        [statusProperty]: {
          status: {
            name: newStatus,
          },
        },
      },
    });
  }
}
