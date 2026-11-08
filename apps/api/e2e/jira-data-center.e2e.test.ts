/**
 * E2E: a Jira Data Center ticket provider, end to end through the real API
 * server — validation, the encrypted credential, the ticket sync and the
 * tasks it creates — against a stand-in Data Center node on loopback. The
 * node behaves like a real one where it matters: REST v2 only (v3 is a 404),
 * and a personal access token as a Bearer header is the only way in.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

const PAT = "OTk5OTk5OTk5OTk5OkUyRURhdGFDZW50ZXJQQVQ=";

let server: ApiServerHandle;
let jira: http.Server;
let jiraPort: number;
const seen: Array<{ method: string; path: string; auth?: string }> = [];

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json;charset=UTF-8" });
  res.end(JSON.stringify(body));
}

function issue(n: number) {
  return {
    key: `OPS-${n}`,
    fields: {
      summary: `DC ticket ${n}`,
      description: `Fix thing ${n}\n{code}npm test{code}`,
      status: { name: "Open", statusCategory: { key: "new" } },
      priority: { name: "Major" },
      assignee: { displayName: "Alice" },
      created: "2026-11-01T10:00:00.000+0200",
      updated: "2026-11-02T10:00:00.000+0200",
      labels: ["optio", "repo:acme/backend"],
      project: { key: "OPS" },
    },
  };
}

beforeAll(async () => {
  jira = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://jira");
    seen.push({ method: req.method!, path: url.pathname, auth: req.headers.authorization });
    req.resume();
    if (!url.pathname.startsWith("/jira/rest/api/2/")) return json(res, 404, {});
    if (req.headers.authorization !== `Bearer ${PAT}`) {
      return json(res, 401, { errorMessages: ["You are not authenticated."] });
    }
    if (url.pathname === "/jira/rest/api/2/search") {
      return json(res, 200, { startAt: 0, maxResults: 50, total: 2, issues: [issue(1), issue(2)] });
    }
    if (/\/issue\/OPS-\d+\/comment$/.test(url.pathname)) {
      return json(res, 200, {
        startAt: 0,
        maxResults: 30,
        total: 1,
        comments: [{ author: { displayName: "Bob" }, body: "Repro on 9.12", created: "x" }],
      });
    }
    return json(res, 404, {});
  });
  await new Promise<void>((resolve) => jira.listen(0, "127.0.0.1", resolve));
  jiraPort = (jira.address() as AddressInfo).port;
  // The node is on loopback, so the deployment's outbound policy must list it
  // (as an air-gapped deployment lists its internal Jira host).
  server = await startApiServer({ env: { OPTIO_OUTBOUND_ALLOWED_HOSTS: "127.0.0.1" } });
}, 150_000);

afterAll(async () => {
  await server?.stop();
  jira?.closeAllConnections();
  await new Promise<void>((resolve) => (jira ? jira.close(() => resolve()) : resolve()));
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed };
}

const baseUrl = () => `http://127.0.0.1:${jiraPort}/jira`;

describe("Jira Data Center ticket provider", () => {
  it("refuses a Data Center username in the Cloud email field, and a DC login with no username", async () => {
    const cloud = await call("POST", "/api/tickets/providers", {
      source: "jira",
      config: { baseUrl: baseUrl(), email: "alice", apiToken: "pw" },
    });
    expect(cloud.status, JSON.stringify(cloud.body)).toBe(400);

    const dc = await call("POST", "/api/tickets/providers", {
      source: "jira",
      config: { baseUrl: baseUrl(), flavor: "data-center", apiToken: "pw" },
    });
    expect(dc.status, JSON.stringify(dc.body)).toBe(400);
  });

  it("saves a Data Center provider with a personal access token, keeping the token secret", async () => {
    const created = await call("POST", "/api/tickets/providers", {
      source: "jira",
      config: {
        baseUrl: baseUrl(),
        flavor: "data-center",
        authType: "pat",
        apiToken: PAT,
        projectKey: "OPS",
        label: "optio",
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.provider.hasToken).toBe(true);
    expect(created.body.provider.config).toMatchObject({ flavor: "data-center", authType: "pat" });
    expect(JSON.stringify(created.body)).not.toContain(PAT);

    const list = await call("GET", "/api/tickets/providers");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(PAT);
  });

  it("syncs the Data Center tickets into tasks over REST v2 with the Bearer token", async () => {
    const sync = await call("POST", "/api/tickets/sync");
    expect(sync.status, JSON.stringify(sync.body)).toBe(200);
    expect(sync.body.synced).toBe(2);

    const search = seen.filter((r) => r.path === "/jira/rest/api/2/search");
    expect(search.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.path.startsWith("/jira/rest/api/2/"))).toBe(true);
    expect(seen.every((r) => r.auth === `Bearer ${PAT}`)).toBe(true);

    const providers = await call("GET", "/api/tickets/providers");
    const provider = providers.body.providers.find((p: any) => p.source === "jira");
    expect(provider).toMatchObject({ enabled: true, lastError: null, consecutiveFailures: 0 });

    const tasks = await call("GET", "/api/tasks?limit=50");
    expect(tasks.status).toBe(200);
    const rows: any[] = tasks.body.tasks ?? tasks.body;
    const fromJira = rows.filter((t) => t.ticketSource === "jira");
    expect(fromJira.map((t) => t.ticketExternalId).sort()).toEqual(["OPS-1", "OPS-2"]);
    expect(fromJira[0].repoUrl).toBe("https://github.com/acme/backend");
  });

  it("does not create the same tasks twice on the next sweep", async () => {
    const sync = await call("POST", "/api/tickets/sync");
    expect(sync.body.synced).toBe(0);
  });
});
