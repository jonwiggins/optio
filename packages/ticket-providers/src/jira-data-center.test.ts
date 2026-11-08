import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setOutboundDefaults } from "@optio/shared/outbound-http";
import { JiraTicketProvider, type JiraProviderConfig } from "./jira.js";

/**
 * A stand-in for a self-hosted Jira Data Center 8.x/9.x node, faithful to the
 * parts the provider touches:
 * - only REST v2 exists (`/rest/api/3/*` and `/rest/api/2/search/jql` are 404);
 * - basic auth is username + password, or a personal access token as a Bearer
 *   header; an email address is not a login, so `email:token` is a 401;
 * - search pages with `startAt` / `total`, descriptions and comments are wiki
 *   text strings, and a comment body must be a string (ADF is a 400).
 */
const USERNAME = "alice";
const PASSWORD = "s3cret";
const PAT = "NjE2OTk3ODY3NzQ2Ok9wdGlvVGVzdFBBVA==";
const ISSUE_COUNT = 130;

type Seen = { method: string; path: string; query: URLSearchParams; auth?: string; body: string };
const seen: Seen[] = [];
const comments: Array<{ author: { displayName: string }; body: string; created: string }> = [];
let transitioned: string | undefined;
let server: http.Server;
let port: number;
let restoreOutbound: (() => void) | undefined;

function authorized(header: string | undefined): boolean {
  if (header === `Bearer ${PAT}`) return true;
  return header === `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;
}

function issue(n: number) {
  return {
    key: `OPS-${n}`,
    fields: {
      summary: `Ticket ${n}`,
      description: `h2. Steps\nTicket ${n} body in wiki markup`,
      status: { name: "Open", statusCategory: { key: "new" } },
      priority: { name: "Major" },
      assignee: { displayName: "Alice" },
      created: "2026-11-01T10:00:00.000+0200",
      updated: "2026-11-02T10:00:00.000+0200",
      labels: n === 1 ? ["optio", "repo:acme/backend"] : ["optio"],
      project: { key: "OPS" },
    },
  };
}

function send(res: http.ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, { "content-type": "application/json;charset=UTF-8" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url!, "http://jira-dc");
    seen.push({
      method: req.method!,
      path: url.pathname,
      query: url.searchParams,
      auth: req.headers.authorization,
      body,
    });
    const path = url.pathname.replace(/^\/jira/, "");

    if (!path.startsWith("/rest/api/2/") || path.startsWith("/rest/api/2/search/jql")) {
      return send(res, 404, { message: "null for uri" });
    }
    if (!authorized(req.headers.authorization)) {
      return send(res, 401, { errorMessages: ["You are not authenticated."] });
    }

    if (path === "/rest/api/2/search" && req.method === "GET") {
      const startAt = Number(url.searchParams.get("startAt") ?? 0);
      const maxResults = Math.min(Number(url.searchParams.get("maxResults") ?? 50), 50);
      const issues = [];
      for (let n = startAt + 1; n <= Math.min(startAt + maxResults, ISSUE_COUNT); n++) {
        issues.push(issue(n));
      }
      return send(res, 200, { startAt, maxResults, total: ISSUE_COUNT, issues });
    }
    const m = path.match(/^\/rest\/api\/2\/issue\/([A-Z]+-\d+)(\/comment|\/transitions)?$/);
    if (!m) return send(res, 404, { message: "not found" });
    if (!m[2]) return send(res, 200, issue(Number(m[1].split("-")[1])));
    if (m[2] === "/comment" && req.method === "GET") {
      return send(res, 200, { startAt: 0, maxResults: 30, total: comments.length, comments });
    }
    if (m[2] === "/comment" && req.method === "POST") {
      const parsed = JSON.parse(body || "{}");
      if (typeof parsed.body !== "string") {
        return send(res, 400, {
          errorMessages: ["Can not deserialize instance of java.lang.String out of START_OBJECT"],
        });
      }
      comments.unshift({
        author: { displayName: "Optio Bot" },
        body: parsed.body,
        created: "2026-11-04T19:00:00.000+0200",
      });
      return send(res, 201, { id: "10100", body: parsed.body });
    }
    if (m[2] === "/transitions" && req.method === "GET") {
      return send(res, 200, {
        transitions: [
          { id: "11", name: "Start", to: { name: "In Progress" } },
          { id: "31", name: "Resolve", to: { name: "Done" } },
        ],
      });
    }
    if (m[2] === "/transitions" && req.method === "POST") {
      transitioned = JSON.parse(body).transition?.id;
      res.writeHead(204);
      return res.end();
    }
    return send(res, 405, { message: "method not allowed" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
  comments.length = 0;
  transitioned = undefined;
  restoreOutbound = setOutboundDefaults({
    resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
    policy: { allowPrivate: false, allowAll: false, allowedHosts: ["127.0.0.1"] },
  });
});

afterEach(() => restoreOutbound?.());

const baseUrl = () => `http://jira.corp.test:${port}/jira`;
const provider = new JiraTicketProvider();

const basicConfig = (): JiraProviderConfig => ({
  baseUrl: baseUrl(),
  flavor: "data-center",
  authType: "basic",
  username: USERNAME,
  apiToken: PASSWORD,
  projectKey: "OPS",
});
const patConfig = (): JiraProviderConfig => ({
  baseUrl: baseUrl(),
  flavor: "data-center",
  authType: "pat",
  apiToken: PAT,
});

describe("Jira Data Center against a mock DC node", () => {
  it.each([
    ["username + password", basicConfig],
    ["personal access token", patConfig],
  ])("syncs every page of tickets with %s over REST v2", async (_name, config) => {
    const tickets = await provider.fetchActionableTickets(config());

    expect(tickets).toHaveLength(ISSUE_COUNT);
    expect(seen.every((r) => r.path === "/jira/rest/api/2/search")).toBe(true);
    // DC caps a page at 50 here: 130 tickets take three startAt pages.
    expect(seen).toHaveLength(3);
    expect(tickets[0]).toMatchObject({
      externalId: "OPS-1",
      title: "Ticket 1",
      body: "h2. Steps\nTicket 1 body in wiki markup",
      url: `${baseUrl()}/browse/OPS-1`,
      repo: "acme/backend",
      metadata: { status: "Open", projectKey: "OPS" },
    });
  });

  it("sends Basic username:password, never an email, for basic auth", async () => {
    await provider.fetchActionableTickets(basicConfig());
    expect(seen[0].auth).toBe(`Basic ${Buffer.from("alice:s3cret").toString("base64")}`);
  });

  it("sends the personal access token as a Bearer header", async () => {
    await provider.fetchActionableTickets(patConfig());
    expect(seen[0].auth).toBe(`Bearer ${PAT}`);
  });

  it("keeps the label and project filters in the JQL", async () => {
    await provider.fetchActionableTickets(basicConfig());
    const jql = seen[0].query.get("jql") ?? "";
    expect(jql).toContain('labels = "optio"');
    expect(jql).toContain('project = "OPS"');
    expect(seen.map((r) => r.query.get("startAt"))).toEqual(["0", "50", "100"]);
  });

  it("reads ticket state, comments, comments back, and transitions over REST v2", async () => {
    expect(await provider.fetchTicketState("OPS-7", patConfig())).toBe("open");

    await provider.addComment("OPS-7", 'Optio opened a PR: "fix it"', patConfig());
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ body: 'Optio opened a PR: "fix it"' });

    const read = await provider.fetchTicketComments("OPS-7", patConfig());
    expect(read).toEqual([
      {
        author: "Optio Bot",
        body: 'Optio opened a PR: "fix it"',
        createdAt: "2026-11-04T19:00:00.000+0200",
      },
    ]);

    await provider.updateState("OPS-7", "closed", patConfig());
    expect(transitioned).toBe("31");
    expect(seen.every((r) => r.path.startsWith("/jira/rest/api/2/"))).toBe(true);
  });

  it("surfaces a 401 when DC credentials are wrong", async () => {
    await expect(
      provider.fetchActionableTickets({ ...basicConfig(), apiToken: "wrong" }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("reproduces the original bug: Cloud-style email + token against DC fails", async () => {
    // What every DC provider row saved before this change looked like.
    await expect(
      provider.fetchActionableTickets({
        baseUrl: baseUrl(),
        email: "alice@corp.test",
        apiToken: PASSWORD,
      }),
    ).rejects.toThrow(/HTTP 404 .*flavor set to data-center/);
    expect(seen[0].path).toBe("/jira/rest/api/3/search/jql");
  });
});
