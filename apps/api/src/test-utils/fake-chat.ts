import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChatFormat } from "@optio/shared";
import type { FetchLike } from "../utils/outbound-url.js";

/**
 * An in-process stand-in for the chat services' incoming webhooks (tests of
 * services/notify/chat-posts.ts, chat-formats.ts, chat-hooks.ts and the
 * outbound webhooks). Each route takes a body the way the service's public
 * documentation describes, refuses what it says the service refuses, and
 * answers as the service does:
 *
 *   discord     POST /api/webhooks/<id>/<token>         204 (200 + the message with ?wait=true)
 *   googlechat  POST /v1/spaces/<space>/messages?key&token   200 { name, thread }
 *   mattermost  POST /hooks/<id>                         200 "ok"
 *   msteams     POST /webhookb2/…  200 "1";  POST /workflows/…  202
 *   rocketchat  POST /hooks/<id>/<token>                 200 { success: true }
 *   slack       POST /services/<T>/<B>/<secret>          200 "ok"
 *   webex       POST /v1/webhooks/incoming/<id>          204
 *   zulip       POST /api/v1/external/slack_incoming?api_key&stream   200 { result: "success" }
 *
 * What it checks comes from the services' public docs (limits, required
 * fields, the answers); Zulip's conversion of a Slack-style message is
 * mirrored from its source (zerver/data_import/slack_message_conversion.py),
 * so `post.rendered` is the text Zulip would show. No live service was
 * reached to write it.
 *
 *   const chat = await startFakeChat();
 *   const restore = setOutboundDefaults({ fetchImpl: chat.fetch, resolveHost: chat.resolveHost });
 *   // POST https://discord.com/api/webhooks/1/abc → here, recorded as service "discord"
 *   chat.urlFor("discord"); chat.posts; chat.failNext("discord", 429);
 *   restore(); await chat.close();
 */

export interface FakeChatPost {
  service: ChatFormat;
  /** The host the request was meant for (`chat.fetch` keeps it). */
  host: string | null;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  /** The answer's status. */
  status: number;
  /** Why the service would refuse it, when it did. */
  refused?: string;
  /** Zulip: the message text after Zulip's Slack conversion ("" posts nothing). */
  rendered?: string;
}

export interface FakeChat {
  url: string;
  posts: FakeChatPost[];
  /** The accepted posts to one service. */
  postsTo(service: ChatFormat): FakeChatPost[];
  /** A public-looking incoming webhook URL of `service` (`chat.fetch` brings it here). */
  urlFor(service: ChatFormat): string;
  /** The next post to `service` answers `status` (once). */
  failNext(service: ChatFormat, status: number): void;
  /** A `fetch` that sends any URL's path and query here, keeping the host in a header. */
  fetch: FetchLike;
  /** DNS for the outbound guard: every name is a public address. */
  resolveHost: (host: string) => Promise<Array<{ address: string; family: 4 }>>;
  close(): Promise<void>;
}

const URLS: Record<ChatFormat, string> = {
  discord: "https://discord.com/api/webhooks/123456789012345678/tok-EN_abc",
  googlechat: "https://chat.googleapis.com/v1/spaces/AAAAexample/messages?key=k-1&token=t-1",
  mattermost: "https://chat.example.com/hooks/xyz123",
  msteams: "https://example.webhook.office.com/webhookb2/a@b/IncomingWebhook/c/d",
  rocketchat: "https://chat.example.com/hooks/abc123/tok456",
  slack: "https://hooks.slack.com/services/T000/B000/XXXX",
  webex: "https://webexapis.com/v1/webhooks/incoming/Y2lzY29zcGFyazovL3Vz",
  zulip: "https://zulip.example.com/api/v1/external/slack_incoming?api_key=k-1&stream=optio",
};

const HOST_HEADER = "x-fake-chat-host";

async function bodyOf(req: IncomingMessage): Promise<{ raw: string; json: unknown }> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return { raw, json: JSON.parse(raw) };
  } catch {
    return { raw, json: undefined };
  }
}

function serviceOf(path: string): ChatFormat | null {
  if (/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/.test(path)) return "discord";
  if (/^\/v1\/spaces\/[^/]+\/messages$/.test(path)) return "googlechat";
  if (/^\/v1\/webhooks\/incoming\/[^/]+$/.test(path)) return "webex";
  if (/^\/hooks\/[^/]+\/[^/]+$/.test(path)) return "rocketchat";
  if (/^\/hooks\/[^/]+$/.test(path)) return "mattermost";
  if (path === "/api/v1/external/slack_incoming") return "zulip";
  if (path.startsWith("/services/")) return "slack";
  if (path.startsWith("/webhookb2/") || path.startsWith("/workflows/")) return "msteams";
  return null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const nonEmpty = (v: unknown): v is string => str(v) && v.trim().length > 0;
const httpUrl = (v: unknown) => str(v) && /^https?:\/\/\S+$/.test(v);

/** What the service answers: [status, body, why it refused]. */
type Answer = { status: number; body: unknown; refused?: string; rendered?: string };
const refuse = (status: number, body: unknown, why: string): Answer => ({
  status,
  body,
  refused: why,
});

// ── Discord (docs: Execute Webhook; Embed Limits; Allowed Mentions) ─────────

function discord(json: unknown, query: Record<string, string>): Answer {
  const invalid = (why: string) =>
    refuse(400, { code: 50035, message: "Invalid Form Body", errors: { why } }, why);
  if (!isObj(json)) return invalid("not a JSON object");
  const embeds = json.embeds;
  if (embeds !== undefined && !Array.isArray(embeds)) return invalid("embeds is not an array");
  if (!nonEmpty(json.content) && !(Array.isArray(embeds) && embeds.length)) {
    return refuse(400, { code: 50006, message: "Cannot send an empty message" }, "empty message");
  }
  if (str(json.content) && json.content.length > 2000) return invalid("content over 2000");
  if (Array.isArray(embeds)) {
    if (embeds.length > 10) return invalid("more than 10 embeds");
    let total = 0;
    for (const e of embeds) {
      if (!isObj(e)) return invalid("an embed is not an object");
      const len = (v: unknown) => (str(v) ? v.trim().length : 0);
      if (len(e.title) > 256) return invalid("embed title over 256");
      if (len(e.description) > 4096) return invalid("embed description over 4096");
      if (e.url !== undefined && !httpUrl(e.url)) return invalid("embed url is not a URL");
      if (e.color !== undefined) {
        if (!Number.isInteger(e.color) || (e.color as number) < 0 || (e.color as number) > 0xffffff)
          return invalid("embed color is not a 24-bit integer");
      }
      total += len(e.title) + len(e.description);
      const fields = e.fields ?? [];
      if (!Array.isArray(fields) || fields.length > 25) return invalid("more than 25 fields");
      for (const f of fields) {
        if (!isObj(f) || !nonEmpty(f.name) || !nonEmpty(f.value)) {
          return invalid("a field needs a name and a value");
        }
        if (len(f.name) > 256) return invalid("field name over 256");
        if (len(f.value) > 1024) return invalid("field value over 1024");
        total += len(f.name) + len(f.value);
      }
    }
    if (total > 6000) return invalid("embeds over 6000 characters in all");
  }
  const am = json.allowed_mentions;
  if (am !== undefined) {
    if (!isObj(am)) return invalid("allowed_mentions is not an object");
    if (am.parse !== undefined) {
      const ok = ["roles", "users", "everyone"];
      if (!Array.isArray(am.parse) || am.parse.some((p) => !ok.includes(p as string)))
        return invalid("allowed_mentions.parse has an unknown type");
      if (am.users !== undefined || am.roles !== undefined)
        return invalid("allowed_mentions.parse with users or roles");
    }
  }
  if (query.wait === "true") {
    return { status: 200, body: { id: "1", type: 0, content: json.content ?? "", embeds } };
  }
  return { status: 204, body: undefined };
}

// ── Google Chat (docs: incoming webhooks quickstart; Message, Cards v2) ─────

const CHAT_MESSAGE_FIELDS = new Set([
  "text",
  "cardsV2",
  "thread",
  "fallbackText",
  "accessoryWidgets",
  "formattedText",
  "privateMessageViewer",
  "attachment",
]);
const WIDGETS = new Set([
  "textParagraph",
  "decoratedText",
  "buttonList",
  "divider",
  "image",
  "columns",
  "grid",
]);

let chatSeq = 0;

function googleChat(json: unknown, raw: string, query: Record<string, string>): Answer {
  const invalid = (why: string) =>
    refuse(
      400,
      {
        error: {
          code: 400,
          message: `Invalid JSON payload received. ${why}`,
          status: "INVALID_ARGUMENT",
        },
      },
      why,
    );
  if (!query.key || !query.token) {
    return refuse(
      400,
      {
        error: {
          code: 400,
          message: "Request contains an invalid argument.",
          status: "INVALID_ARGUMENT",
        },
      },
      "no key or token",
    );
  }
  if (!isObj(json)) return invalid("not a JSON object");
  for (const k of Object.keys(json)) {
    if (!CHAT_MESSAGE_FIELDS.has(k)) return invalid(`Unknown name "${k}": Cannot find field.`);
  }
  if (Buffer.byteLength(raw) > 32_000) return invalid("message over 32,000 bytes");
  const cards = json.cardsV2;
  if (!nonEmpty(json.text) && !(Array.isArray(cards) && cards.length)) {
    return invalid("Message cannot be empty");
  }
  if (cards !== undefined) {
    if (!Array.isArray(cards)) return invalid("cardsV2 is not a list");
    for (const c of cards) {
      if (!isObj(c) || !isObj(c.card)) return invalid("a cardsV2 entry needs a card");
      if (cards.length > 1 && !nonEmpty(c.cardId))
        return invalid("cardId is required with several cards");
      const card = c.card;
      if (card.header !== undefined && (!isObj(card.header) || !nonEmpty(card.header.title))) {
        return invalid("a card header needs a title");
      }
      if (!Array.isArray(card.sections) || !card.sections.length) {
        return invalid("a card needs a section");
      }
      for (const s of card.sections) {
        if (!isObj(s) || !Array.isArray(s.widgets) || !s.widgets.length) {
          return invalid("a section needs a widget");
        }
        for (const w of s.widgets) {
          const kinds = isObj(w) ? Object.keys(w).filter((k) => WIDGETS.has(k)) : [];
          if (!isObj(w) || kinds.length !== 1 || Object.keys(w).length !== 1) {
            return invalid("a widget is exactly one kind");
          }
          const kind = kinds[0]!;
          const v = w[kind];
          if (kind === "textParagraph" && !(isObj(v) && str(v.text)))
            return invalid("textParagraph.text");
          if (kind === "decoratedText" && !(isObj(v) && str(v.text)))
            return invalid("decoratedText.text");
          if (kind === "buttonList") {
            const buttons = isObj(v) ? v.buttons : null;
            if (!Array.isArray(buttons) || !buttons.length) return invalid("buttonList.buttons");
            for (const b of buttons) {
              const url =
                isObj(b) && isObj(b.onClick) && isObj(b.onClick.openLink)
                  ? b.onClick.openLink.url
                  : null;
              if (!isObj(b) || !nonEmpty(b.text) || !httpUrl(url))
                return invalid("a button opens a URL");
            }
          }
        }
      }
    }
  }
  const n = ++chatSeq;
  return {
    status: 200,
    body: {
      name: `spaces/AAAAexample/messages/m${n}`,
      thread: { name: `spaces/AAAAexample/threads/t${n}` },
    },
  };
}

// ── Webex (docs: Incoming Webhooks app; Messages API; app limits) ───────────

function webex(json: unknown): Answer {
  if (!isObj(json)) return refuse(400, { message: "Invalid JSON" }, "not a JSON object");
  if (!nonEmpty(json.text) && !nonEmpty(json.markdown)) {
    return refuse(
      400,
      { message: "Both text and markdown cannot be empty in the same request." },
      "empty message",
    );
  }
  for (const k of ["text", "markdown"] as const) {
    const v = json[k];
    if (str(v) && (Buffer.byteLength(v) > 7439 || v.length > 5400)) {
      return refuse(
        400,
        { message: "Message too long" },
        `${k} over 7439 bytes or 5400 characters`,
      );
    }
  }
  return { status: 204, body: undefined };
}

// ── Rocket.Chat (docs: Integrations → Incoming; Post Message) ───────────────

function rocketChat(json: unknown): Answer {
  const invalid = (why: string) => refuse(400, { success: false, error: why }, why);
  if (!isObj(json)) return invalid("not a JSON object");
  const attachments = json.attachments;
  if (attachments !== undefined && !Array.isArray(attachments))
    return invalid("attachments is not an array");
  if (!nonEmpty(json.text) && !(Array.isArray(attachments) && attachments.length)) {
    return invalid("text is required");
  }
  for (const a of (attachments as unknown[]) ?? []) {
    if (!isObj(a)) return invalid("an attachment is not an object");
    if (a.title_link !== undefined && !httpUrl(a.title_link))
      return invalid("title_link is not a URL");
    if (a.fields !== undefined) {
      if (!Array.isArray(a.fields)) return invalid("fields is not an array");
      for (const f of a.fields) {
        if (!isObj(f) || !str(f.title) || !str(f.value))
          return invalid("a field has a title and a value");
      }
    }
  }
  return { status: 200, body: { success: true } };
}

// ── Mattermost, Microsoft Teams, Slack (the formats Optio had already) ──────

function mattermost(json: unknown): Answer {
  if (!isObj(json) || (!nonEmpty(json.text) && !Array.isArray(json.attachments))) {
    return refuse(
      400,
      { id: "web.incoming_webhook.text.app_error", message: "No text specified", status_code: 400 },
      "no text",
    );
  }
  return { status: 200, body: "ok" };
}

function teams(json: unknown, path: string): Answer {
  const card = isObj(json) && Array.isArray(json.attachments) ? json.attachments[0] : null;
  if (
    !isObj(json) ||
    json.type !== "message" ||
    !isObj(card) ||
    card.contentType !== "application/vnd.microsoft.card.adaptive" ||
    !isObj(card.content) ||
    card.content.type !== "AdaptiveCard"
  ) {
    return refuse(400, "Summary or Text is required.", "not a message with an Adaptive Card");
  }
  return path.startsWith("/workflows/")
    ? { status: 202, body: undefined }
    : { status: 200, body: "1" };
}

function slack(json: unknown): Answer {
  if (!isObj(json)) return refuse(400, "invalid_payload", "not a JSON object");
  const blocks = json.blocks;
  if (!nonEmpty(json.text) && !(Array.isArray(blocks) && blocks.length)) {
    return refuse(400, "no_text", "no text");
  }
  if (Array.isArray(blocks)) {
    if (blocks.length > 50) return refuse(400, "invalid_blocks", "more than 50 blocks");
    for (const b of blocks) {
      if (!isObj(b) || !str(b.type)) return refuse(400, "invalid_blocks", "a block has a type");
      const text = isObj(b.text) ? b.text.text : undefined;
      if (b.type === "header" && !(str(text) && text.length <= 150)) {
        return refuse(400, "invalid_blocks", "a header's text is up to 150");
      }
      if (b.type === "section") {
        if (text !== undefined && !(str(text) && text.length <= 3000)) {
          return refuse(400, "invalid_blocks", "a section's text is up to 3000");
        }
        const fields = b.fields;
        if (fields !== undefined) {
          if (!Array.isArray(fields) || fields.length > 10) {
            return refuse(400, "invalid_blocks", "a section has up to 10 fields");
          }
          for (const f of fields) {
            if (!isObj(f) || !str(f.text) || f.text.length > 2000) {
              return refuse(400, "invalid_blocks", "a field's text is up to 2000");
            }
          }
        }
        if (text === undefined && fields === undefined) {
          return refuse(400, "invalid_blocks", "a section has text or fields");
        }
      }
    }
  }
  return { status: 200, body: "ok" };
}

// ── Zulip (docs: Slack-compatible incoming webhook; its conversion source) ──

/** Zulip's SLACK_*_REGEX: Slack's `*x*`, `~x~`, `_x_` at word boundaries. */
function slackStyle(delim: "*" | "~" | "_"): RegExp {
  const d = delim === "*" ? "\\*" : delim;
  return new RegExp(
    `((?![${d}\`@\\\\\\p{Pf}\\p{Pe}])[\\p{P}\\p{Zs}\\p{S}]|^)(${d})([^${d}]+)(${d})((?![${d}\`@\\\\\\p{Pi}\\p{Ps}])(?=[\\p{P}\\p{Zs}\\p{S}]|$))`,
    "gmu",
  );
}

const LINK =
  /(<)(http:\/\/www\.|https:\/\/www\.|http:\/\/|https:\/\/|ftp:\/\/)?([a-z0-9]+([-.]{1}[a-z0-9]+)*)(\.)([a-z]{2,63}(:[0-9]{1,5})?)(\/[^>]*)?(\|)?(?:\|([^>]+))?(>)/g;

/** The text Zulip shows for a Slack-style `text`: links, then bold, strike, italic. */
export function zulipRendering(text: string): string {
  let out = text;
  for (const m of text.matchAll(LINK)) {
    const parts = m[0].slice(1, -1).split("|");
    const [href, ...label] = parts;
    out = out.split(m[0]).join(label.length ? `[${label.join("|")}](${href})` : href!);
  }
  const convert = (s: string, re: RegExp, kw: string) =>
    s.replace(
      re,
      (_all, before: string, _o: string, inner: string) => `${before}${kw}${inner}${kw}`,
    );
  out = convert(out.trim(), slackStyle("*"), "**");
  out = convert(out, slackStyle("~"), "~~");
  out = convert(out, slackStyle("_"), "*");
  return out;
}

function zulip(json: unknown, query: Record<string, string>): Answer {
  if (!query.api_key) {
    return refuse(
      401,
      { result: "error", msg: "Missing 'api_key' argument", code: "UNAUTHORIZED" },
      "no api_key",
    );
  }
  if (!isObj(json)) {
    return refuse(400, { ok: false, error: "Malformed payload" }, "not a JSON object");
  }
  // Zulip renders blocks and attachments too; Optio sends `text` only.
  const rendered = str(json.text) ? zulipRendering(json.text) : "";
  return { status: 200, body: { result: "success", msg: "", ok: true }, rendered };
}

// ── The server ──────────────────────────────────────────────────────────────

export async function startFakeChat(): Promise<FakeChat> {
  const posts: FakeChatPost[] = [];
  const failures = new Map<ChatFormat, number>();

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake-chat");
    const path = url.pathname.replace(/\/+$/, "");
    const query = Object.fromEntries(url.searchParams);
    const { raw, json } = await bodyOf(req);
    const send = (status: number, body: unknown) => {
      if (body === undefined || status === 204) {
        res.writeHead(status);
        return res.end();
      }
      const text = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(status, {
        "content-type": typeof body === "string" ? "text/plain" : "application/json",
      });
      res.end(text);
    };
    const service = req.method === "POST" ? serviceOf(path) : null;
    if (!service) return send(404, { message: "Not Found" });
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]),
    );
    const contentType = headers["content-type"] ?? "";
    let answer: Answer;
    const failure = failures.get(service);
    if (failure) {
      failures.delete(service);
      answer = refuse(failure, { message: "failing on purpose" }, `failNext(${failure})`);
    } else if (!contentType.startsWith("application/json")) {
      answer = refuse(415, { message: "Unsupported Media Type" }, "not JSON");
    } else {
      switch (service) {
        case "discord":
          answer = discord(json, query);
          break;
        case "googlechat":
          answer = googleChat(json, raw, query);
          break;
        case "webex":
          answer = webex(json);
          break;
        case "rocketchat":
          answer = rocketChat(json);
          break;
        case "zulip":
          answer = zulip(json, query);
          break;
        case "mattermost":
          answer = mattermost(json);
          break;
        case "msteams":
          answer = teams(json, path);
          break;
        case "slack":
          answer = slack(json);
          break;
      }
    }
    posts.push({
      service,
      host: headers[HOST_HEADER] || null,
      path,
      query,
      headers,
      body: json ?? raw,
      status: answer.status,
      ...(answer.refused ? { refused: answer.refused } : {}),
      ...(answer.rendered !== undefined ? { rendered: answer.rendered } : {}),
    });
    send(answer.status, answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: base,
    posts,
    postsTo: (service) => posts.filter((p) => p.service === service && !p.refused),
    urlFor: (service) => URLS[service],
    failNext: (service, status) => void failures.set(service, status),
    fetch: async (target, init) => {
      const u = new URL(target);
      const headers = new Headers(init.headers);
      headers.set(HOST_HEADER, u.host);
      return fetch(`${base}${u.pathname}${u.search}`, { ...init, headers });
    },
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 as const }],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
