/**
 * Notion in the ticket round trip (docs/ticket-round-trip.md, the Notion
 * section), over Notion's REST API (`https://api.notion.com/v1`,
 * `Notion-Version: 2022-06-28` as the sync's client uses, the integration's
 * token). A ticket is a page of the provider's database.
 *
 *   comments     POST /v1/comments (`parent.page_id`, rich text with links);
 *                GET  /v1/comments?block_id=<page> (open discussions)
 *   the link     none: Notion has no link that updates in place, so the
 *                comments carry the links
 *   statuses     the options of the database's status property
 *                (`statusProperty`, default "Status"; a select works too):
 *                GET /v1/databases/:id, PATCH /v1/pages/:id
 *   who am I     GET /v1/users/me (the integration's bot user)
 *
 * The integration needs the "Read comments" and "Insert comments"
 * capabilities for comments, and "Update content" to move a page.
 */
import type { TicketProviderConfig } from "@optio/shared";
import {
  atMentions,
  sameName,
  serviceCall,
  type CommentPart,
  type TicketCommentRecord,
  type TicketRoundTrip,
} from "./round-trip.js";

const API = "https://api.notion.com/v1";
const SERVICE = "Notion";
/** Notion's limit on one rich-text item's content. */
const TEXT_MAX = 2000;

interface NotionRoundTripConfig {
  apiKey: string;
  databaseId: string;
  statusProperty?: string;
}

function asConfig(config: TicketProviderConfig): NotionRoundTripConfig {
  const c = config as Partial<NotionRoundTripConfig>;
  if (!c.apiKey || !c.databaseId) {
    throw new Error("Notion provider requires apiKey and databaseId in config");
  }
  return c as NotionRoundTripConfig;
}

function call<T>(
  config: TicketProviderConfig,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  return serviceCall<T>(SERVICE, `${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${asConfig(config).apiKey}`,
      "Notion-Version": "2022-06-28",
    },
  });
}

/** A page id with dashes (`xxxxxxxx-xxxx-…`), from 32 hex digits with or without them. */
function pageId(ticketId: string): string {
  const hex = ticketId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`Not a Notion page id: ${ticketId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A comment as Notion rich text: text items (at most 2000 characters each), links as link items. */
export function notionRichText(parts: CommentPart[]) {
  const out: Array<{ type: "text"; text: { content: string; link: { url: string } | null } }> = [];
  for (const p of parts) {
    const content = typeof p === "string" ? p : p.text || p.href;
    const link = typeof p === "string" ? null : { url: p.href };
    for (let i = 0; i < content.length; i += TEXT_MAX) {
      out.push({ type: "text", text: { content: content.slice(i, i + TEXT_MAX), link } });
    }
  }
  return out;
}

interface NotionProperty {
  type?: string;
  status?: { name?: string } | { options?: Array<{ id: string; name: string }>; groups?: any[] };
  select?: { name?: string } | { options?: Array<{ id: string; name: string }> };
}

/** The status property's options, with Notion's group (To-do, In progress, Complete) as category. */
async function statusOptions(config: TicketProviderConfig) {
  const c = asConfig(config);
  const prop = c.statusProperty ?? "Status";
  const db = (
    await call<{ properties?: Record<string, NotionProperty> }>(
      config,
      `/databases/${encodeURIComponent(c.databaseId)}`,
    )
  ).body;
  const p = db?.properties?.[prop];
  if (!p || (p.type !== "status" && p.type !== "select")) {
    throw new Error(`The database has no status or select property named "${prop}"`);
  }
  const def = (p.type === "status" ? p.status : p.select) as {
    options?: Array<{ id: string; name: string }>;
    groups?: Array<{ name: string; option_ids?: string[] }>;
  };
  const groupOf = (id: string) => def.groups?.find((g) => g.option_ids?.includes(id))?.name;
  return {
    prop,
    type: p.type as "status" | "select",
    options: (def.options ?? []).map((o) => ({ name: o.name, category: groupOf(o.id) })),
  };
}

async function pageStatus(ticketId: string, config: TicketProviderConfig, prop: string) {
  const page = (
    await call<{ properties?: Record<string, NotionProperty> }>(
      config,
      `/pages/${pageId(ticketId)}`,
    )
  ).body;
  const p = page?.properties?.[prop];
  const value = (p?.type === "select" ? p.select : p?.status) as { name?: string } | null;
  return value?.name ?? null;
}

export const notionRoundTrip: TicketRoundTrip = {
  source: "notion",
  capabilities: { links: false, statuses: true },

  normalizeTicketId: (input) => {
    const m = input
      .trim()
      .match(
        /([0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12})(?:[?#].*)?$/,
      );
    return m ? pageId(m[1]) : null;
  },

  async whoAmI(config) {
    const me = (await call<{ id: string; name?: string | null }>(config, "/users/me")).body;
    return { accountId: me.id, name: me.name ?? null, displayName: me.name ?? null };
  },

  async listComments(ticketId, config, max = 50) {
    const rows: TicketCommentRecord[] = [];
    let cursor: string | null = null;
    const cursors = new Set<string>();
    // Notion has no descending sort: walk every page to find the newest
    // comments, including tickets with more than 500 comments.
    for (;;) {
      const q = new URLSearchParams({ block_id: pageId(ticketId), page_size: "100" });
      if (cursor) q.set("start_cursor", cursor);
      const res = (
        await call<{
          results?: Array<{
            id: string;
            created_time: string;
            created_by?: { id?: string };
            rich_text?: Array<{ plain_text?: string }>;
          }>;
          has_more?: boolean;
          next_cursor?: string | null;
        }>(config, `/comments?${q}`)
      ).body;
      for (const c of res?.results ?? []) {
        rows.push({
          id: c.id,
          author: { accountId: c.created_by?.id ?? null },
          body: (c.rich_text ?? []).map((t) => t.plain_text ?? "").join(""),
          created: c.created_time,
        });
      }
      if (!res?.has_more || !res.next_cursor) break;
      if (cursors.has(res.next_cursor)) throw new Error("Notion repeated a comments cursor");
      cursors.add(res.next_cursor);
      cursor = res.next_cursor;
    }
    return rows.sort((a, b) => Date.parse(a.created) - Date.parse(b.created)).slice(-max);
  },

  async postComment(ticketId, parts, config) {
    const res = await call<{ id?: string }>(config, "/comments", {
      method: "POST",
      body: { parent: { page_id: pageId(ticketId) }, rich_text: notionRichText(parts) },
    });
    return { id: res.body?.id ?? null };
  },

  async upsertLink() {
    // No link that updates in place (capabilities.links is false); the comments carry the links.
    return { id: null };
  },

  async statuses(config) {
    const { options } = await statusOptions(config);
    return { statuses: options, scope: "database" };
  },

  async issueStatus(ticketId, config) {
    const { prop, options } = await statusOptions(config);
    const status = await pageStatus(ticketId, config, prop);
    return {
      status,
      current: status ? [status] : [],
      available: options.map((o) => o.name).filter((n) => !sameName(n, status)),
    };
  },

  async moveToStatus(ticketId, status, config) {
    const { prop, type, options } = await statusOptions(config);
    const from = await pageStatus(ticketId, config, prop);
    if (sameName(from, status)) return { moved: false, from, reason: "already" };
    const target = options.find((o) => sameName(o.name, status));
    if (!target) {
      return {
        moved: false,
        from,
        reason: "unreachable",
        available: options.map((o) => o.name).filter((n) => !sameName(n, from)),
      };
    }
    await call(config, `/pages/${pageId(ticketId)}`, {
      method: "PATCH",
      body: { properties: { [prop]: { [type]: { name: target.name } } } },
    });
    return { moved: true, from };
  },

  /** A mention of the integration reads `@<its name>` in the comment's plain text. */
  mentionsAccount: (body, account) => atMentions(body, account?.displayName),
};
