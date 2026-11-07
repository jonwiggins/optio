import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setOutboundDefaults } from "@optio/shared/outbound-http";
import { JiraTicketProvider, type JiraProviderConfig } from "./jira.js";
import { jiraPostComment, jiraWhoAmI } from "./jira-round-trip.js";

/**
 * A Jira Server / Data Center (REST v2, a personal access token) through the
 * same guarded transport as Cloud (jira-ssrf.test.ts): the vetted address is
 * pinned, a redirect never carries the token anywhere, and the PAT travels as
 * `Authorization: Bearer` to the configured host only.
 */
let server: http.Server;
let port: number;
let mode: "ok" | "redirect" = "ok";
let restoreOutbound: (() => void) | undefined;
const seen: Array<{ path: string; method: string; auth?: string; body: string }> = [];
const resolveHost = vi.fn();
const provider = new JiraTicketProvider();
const config = (): JiraProviderConfig => ({
  baseUrl: `http://jira.test:${port}/jira`,
  deployment: "server",
  authType: "pat",
  apiToken: "server-pat",
});
const operations = [
  ["issues", () => provider.fetchActionableTickets(config())],
  ["comments", () => provider.fetchTicketComments("OPS-1", config())],
  [
    "connection test",
    () =>
      provider
        .testConnection(config())
        .then((r) => (r.ok ? r : Promise.reject(new Error(r.error)))),
  ],
  ["round trip comment", () => jiraPostComment("OPS-1", ["hi"], config())],
  ["round trip account", () => jiraWhoAmI(config())],
] as const;

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ path: req.url!, method: req.method!, auth: req.headers.authorization, body });
    if (mode === "redirect") {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/stolen` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        req.url!.includes("/serverInfo")
          ? { serverTitle: "Jira", version: "9.12.0", deploymentType: "Server" }
          : req.url!.includes("/myself")
            ? { name: "optio", key: "JIRAUSER1", displayName: "Optio" }
            : req.method === "POST"
              ? { id: "10001" }
              : { issues: [], comments: [], total: 0 },
      ),
    );
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
  mode = "ok";
  resolveHost.mockReset().mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
  restoreOutbound = setOutboundDefaults({
    resolveHost,
    policy: { allowPrivate: false, allowAll: false, allowedHosts: ["127.0.0.1"] },
  });
});
afterEach(() => {
  restoreOutbound?.();
});

describe("Jira Server through the guarded transport", () => {
  it.each(operations)("%s: REST v2 under the context path, the PAT as Bearer", async (_n, op) => {
    await op();
    expect(seen.length).toBeGreaterThan(0);
    expect(resolveHost).toHaveBeenCalledTimes(seen.length);
    for (const request of seen) {
      expect(request.path).toMatch(/^\/jira\/rest\/api\/2\//);
      expect(request.auth).toBe("Bearer server-pat");
    }
  });

  it.each(operations)("%s: a redirect is refused before it is followed", async (_n, op) => {
    mode = "redirect";
    await expect(op()).rejects.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen.every((r) => r.path !== "/stolen")).toBe(true);
  });

  it.each(operations)(
    "%s: an address the policy doesn't allow is never reached",
    async (_n, op) => {
      resolveHost.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
      await expect(op()).rejects.toThrow();
      expect(seen).toEqual([]);
    },
  );

  it("a connection test names the server and the account, and a refusal its reason", async () => {
    expect(await provider.testConnection(config())).toEqual({
      ok: true,
      serverTitle: "Jira",
      version: "9.12.0",
      deploymentType: "Server",
      user: "Optio",
    });
    resolveHost.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const refused = await provider.testConnection(config());
    expect(refused.ok).toBe(false);
    expect(refused.error).not.toContain("server-pat");
  });
});
