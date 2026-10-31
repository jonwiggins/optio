import { randomUUID } from "node:crypto";
import { fetchRoutedTo, startFakeHttp, type FakeHttp } from "./fake-http.js";

/**
 * An in-process Notion for tests of the ticket round trip on Notion
 * (@optio/ticket-providers notion-round-trip.ts): the REST calls Optio makes
 * with an integration token and `Notion-Version` — the bot user
 * (`/v1/users/me`), one database with a status property, its pages' status,
 * and comments on pages. Shaped after Notion's API reference (comment and
 * page objects, status options with groups); a stand-in, not Notion.
 *
 *   const notion = await startFakeNotion({ token: "secret_1" });
 *   vi.stubGlobal("fetch", notion.fetch);   // https://api.notion.com → the fake
 *   const page = notion.addPage();
 *   // provider config → { apiKey: "secret_1", databaseId: notion.databaseId }
 */

export const NOTION_API = "https://api.notion.com";

export interface FakeNotionComment {
  object: "comment";
  id: string;
  discussion_id: string;
  created_time: string;
  created_by: { object: "user"; id: string };
  rich_text: Array<{
    type: "text";
    text: { content: string; link: { url: string } | null };
    plain_text: string;
    href: string | null;
  }>;
}

export interface FakeNotionPage {
  id: string;
  status: string;
  comments: FakeNotionComment[];
}

export interface FakeNotion extends FakeHttp {
  fetch: typeof fetch;
  databaseId: string;
  botId: string;
  personId: string;
  options: string[];
  pages: Map<string, FakeNotionPage>;
  addPage(status?: string): FakeNotionPage;
  comment(pageId: string, text: string, authorId?: string, at?: Date): FakeNotionComment;
}

export async function startFakeNotion(opts: { token?: string } = {}): Promise<FakeNotion> {
  const token = opts.token ?? "fake-notion-token";
  const databaseId = randomUUID();
  const botId = randomUUID();
  const personId = randomUUID();
  const options = ["Not started", "In progress", "In review", "Done"];
  const optionIds = new Map(options.map((o) => [o, randomUUID()]));
  const pages = new Map<string, FakeNotionPage>();

  const addPage = (status = "Not started") => {
    const page: FakeNotionPage = { id: randomUUID(), status, comments: [] };
    pages.set(page.id, page);
    return page;
  };
  const richText = (items: Array<{ text?: { content?: string; link?: { url: string } | null } }>) =>
    items.map((i) => ({
      type: "text" as const,
      text: { content: i.text?.content ?? "", link: i.text?.link ?? null },
      plain_text: i.text?.content ?? "",
      href: i.text?.link?.url ?? null,
    }));
  const comment = (pageId: string, text: string, authorId = personId, at = new Date()) => {
    const page = pages.get(pageId)!;
    const c: FakeNotionComment = {
      object: "comment",
      id: randomUUID(),
      discussion_id: randomUUID(),
      created_time: at.toISOString(),
      created_by: { object: "user", id: authorId },
      rich_text: richText([{ text: { content: text } }]),
    };
    page.comments.push(c);
    return c;
  };
  const statusProperty = (name: string) => ({
    id: "st",
    type: "status",
    status: { id: optionIds.get(name), name },
  });

  const http = await startFakeHttp(
    (call, reply) => {
      const { method, path, body } = call;
      if (call.headers["notion-version"] !== "2022-06-28") {
        return reply(400, { object: "error", code: "missing_version", message: "Notion-Version" });
      }
      if (method === "GET" && path === "/v1/users/me") {
        return reply(200, { object: "user", id: botId, type: "bot", name: "Optio", bot: {} });
      }
      if (method === "GET" && path === `/v1/databases/${databaseId}`) {
        return reply(200, {
          object: "database",
          id: databaseId,
          properties: {
            Name: { id: "title", type: "title", title: {} },
            Status: {
              id: "st",
              type: "status",
              status: {
                options: options.map((name) => ({ id: optionIds.get(name), name })),
                groups: [
                  { name: "To-do", option_ids: [optionIds.get("Not started")] },
                  {
                    name: "In progress",
                    option_ids: [optionIds.get("In progress"), optionIds.get("In review")],
                  },
                  { name: "Complete", option_ids: [optionIds.get("Done")] },
                ],
              },
            },
          },
        });
      }
      const pageMatch = path.match(/^\/v1\/pages\/([0-9a-f-]+)$/);
      if (pageMatch) {
        const page = pages.get(pageMatch[1]);
        if (!page)
          return reply(404, {
            object: "error",
            code: "object_not_found",
            message: "Could not find page",
          });
        if (method === "GET") {
          return reply(200, {
            object: "page",
            id: page.id,
            properties: { Status: statusProperty(page.status) },
          });
        }
        if (method === "PATCH") {
          const name = body?.properties?.Status?.status?.name;
          if (!options.includes(name)) {
            return reply(400, {
              object: "error",
              code: "validation_error",
              message: "Invalid status option",
            });
          }
          page.status = name;
          return reply(200, {
            object: "page",
            id: page.id,
            properties: { Status: statusProperty(page.status) },
          });
        }
      }
      if (path === "/v1/comments" && method === "GET") {
        const page = pages.get(call.query.get("block_id") ?? "");
        if (!page)
          return reply(404, {
            object: "error",
            code: "object_not_found",
            message: "Could not find block",
          });
        return reply(200, {
          object: "list",
          results: page.comments,
          has_more: false,
          next_cursor: null,
        });
      }
      if (path === "/v1/comments" && method === "POST") {
        const page = pages.get(body?.parent?.page_id ?? "");
        if (!page)
          return reply(404, {
            object: "error",
            code: "object_not_found",
            message: "Could not find page",
          });
        const c: FakeNotionComment = {
          object: "comment",
          id: randomUUID(),
          discussion_id: randomUUID(),
          created_time: new Date().toISOString(),
          created_by: { object: "user", id: botId },
          rich_text: richText(body?.rich_text ?? []),
        };
        page.comments.push(c);
        return reply(200, c);
      }
      return reply(404, {
        object: "error",
        code: "invalid_request_url",
        message: `No fake for ${method} ${path}`,
      });
    },
    (headers) => headers.authorization === `Bearer ${token}`,
  );

  return {
    ...http,
    fetch: fetchRoutedTo({ [NOTION_API]: http.url }),
    databaseId,
    botId,
    personId,
    options,
    pages,
    addPage,
    comment,
  };
}
