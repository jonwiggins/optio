import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * What the in-process fakes of ticket services (fake-github-issues.ts,
 * fake-gitlab-issues.ts, fake-linear.ts, fake-notion.ts) share: a real HTTP
 * server on 127.0.0.1 that records every call and can fail the next one, and
 * a `fetch` that sends a service's public origin (`https://api.github.com`)
 * to the fake, so the code under test calls the URLs it calls in production.
 *
 *   const gh = await startFakeGitHubIssues();
 *   vi.stubGlobal("fetch", fetchRoutedTo({ "https://api.github.com": gh.url }));
 */

export interface FakeCall {
  method: string;
  /** The path as sent (percent-encoding kept), without the query. */
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: any;
}

export type FakeReply = (
  status: number,
  payload?: unknown,
  headers?: Record<string, string>,
) => void;

export interface FakeHttp {
  url: string;
  calls: FakeCall[];
  /** Calls to `METHOD /path`. */
  callsTo(route: string): FakeCall[];
  /** The next call to `METHOD /path` answers `status` (once). */
  failNext(route: string, status: number): void;
  close(): Promise<void>;
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * A fake service: `handle` answers each call through `reply`; a call that
 * `authorized` refuses gets 401 first, and a `failNext` route its status.
 */
export async function startFakeHttp(
  handle: (call: FakeCall, reply: FakeReply) => void | Promise<void>,
  authorized: (headers: IncomingMessage["headers"]) => boolean,
): Promise<FakeHttp> {
  const calls: FakeCall[] = [];
  const failures = new Map<string, number>();
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const raw = req.url ?? "/";
    const q = raw.indexOf("?");
    const path = (q < 0 ? raw : raw.slice(0, q)).replace(/\/+$/, "") || "/";
    const call: FakeCall = {
      method: req.method ?? "GET",
      path,
      query: new URLSearchParams(q < 0 ? "" : raw.slice(q + 1)),
      headers: req.headers,
      body: req.method === "GET" ? null : await bodyOf(req),
    };
    calls.push(call);
    const reply: FakeReply = (status, payload, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    if (!authorized(req.headers)) return reply(401, { message: "Bad credentials" });
    const route = `${call.method} ${call.path}`;
    const failure = failures.get(route);
    if (failure) {
      failures.delete(route);
      return reply(failure, { message: "injected failure" });
    }
    try {
      await handle(call, reply);
    } catch (err) {
      reply(500, { message: err instanceof Error ? err.message : String(err) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    callsTo: (route) => calls.filter((c) => `${c.method} ${c.path}` === route),
    failNext: (route, status) => void failures.set(route, status),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A `fetch` that sends calls to each listed origin to its fake, and every other call on as is. */
export function fetchRoutedTo(routes: Record<string, string>): typeof fetch {
  const realFetch = globalThis.fetch;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const [origin, fake] of Object.entries(routes)) {
      if (url === origin || url.startsWith(`${origin}/`)) {
        return realFetch(`${fake}${url.slice(origin.length)}`, init);
      }
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

/** One page of `items` (`per_page`, `page`), with a Link header (next, last) and `x-total-pages`. */
export function pageOf<T>(
  items: T[],
  query: URLSearchParams,
  base: string,
): { items: T[]; headers: Record<string, string> } {
  const per = Math.max(1, Math.min(100, Number(query.get("per_page") ?? 30)));
  const page = Math.max(1, Number(query.get("page") ?? 1));
  const last = Math.max(1, Math.ceil(items.length / per));
  const link: string[] = [];
  if (page < last) link.push(`<${base}?per_page=${per}&page=${page + 1}>; rel="next"`);
  if (last > 1) link.push(`<${base}?per_page=${per}&page=${last}>; rel="last"`);
  return {
    items: items.slice((page - 1) * per, page * per),
    headers: {
      ...(link.length ? { link: link.join(", ") } : {}),
      "x-total-pages": String(last),
    },
  };
}
