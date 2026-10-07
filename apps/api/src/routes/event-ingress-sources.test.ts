/**
 * The GitLab, Jira and Sentry receivers: each verifies its provider's token
 * or signature, drops redeliveries, normalizes, and fans out after the ack.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

const mockFire = vi.fn();
vi.mock("../services/event-trigger-service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/event-trigger-service.js")>(
    "../services/event-trigger-service.js",
  );
  return { ...actual, fireEventTriggers: (...args: unknown[]) => mockFire(...args) };
});
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../services/trigger-dispatch.js", () => ({ fireTrigger: vi.fn() }));
const mockRedisSet = vi.fn();
vi.mock("../services/event-bus.js", () => ({
  getRedisClient: () => ({ set: (...args: unknown[]) => mockRedisSet(...args) }),
}));

import { eventIngressRoutes, resetSlackEventDedupe } from "./event-ingress.js";

const GITLAB_SECRET = "gl-token";
const JIRA_SECRET = "jira-secret";
const SENTRY_SECRET = "sentry-client-secret";

const flush = () => new Promise((r) => setTimeout(r, 10));
const hex = (secret: string, raw: string) => createHmac("sha256", secret).update(raw).digest("hex");

let app: FastifyInstance;

beforeEach(async () => {
  process.env.GITLAB_WEBHOOK_SECRET = GITLAB_SECRET;
  process.env.JIRA_WEBHOOK_SECRET = JIRA_SECRET;
  process.env.SENTRY_WEBHOOK_SECRET = SENTRY_SECRET;
  mockFire.mockReset().mockResolvedValue([]);
  mockRedisSet.mockReset().mockResolvedValue("OK");
  resetSlackEventDedupe();
  app = await buildRouteTestApp(eventIngressRoutes, { user: null });
});

afterEach(async () => {
  await app.close();
  delete process.env.GITLAB_WEBHOOK_SECRET;
  delete process.env.JIRA_WEBHOOK_SECRET;
  delete process.env.SENTRY_WEBHOOK_SECRET;
});

describe("POST /api/webhooks/gitlab", () => {
  const PROJECT = { path_with_namespace: "acme/optio", web_url: "https://gitlab.com/acme/optio" };
  const push = JSON.stringify({
    object_kind: "push",
    ref: "refs/heads/main",
    before: "aaaa1111",
    after: "bbbb2222",
    user_username: "alice",
    project: PROJECT,
    commits: [{ id: "bbbb2222", title: "fix: x", message: "fix: x" }],
  });
  const post = (headers: Record<string, string>, payload = push) =>
    app.inject({
      method: "POST",
      url: "/api/webhooks/gitlab",
      headers: { "content-type": "application/json", ...headers },
      payload,
    });

  it("takes the secret token, remembers the event uuid, and dispatches the push", async () => {
    const res = await post({ "x-gitlab-token": GITLAB_SECRET, "x-gitlab-event-uuid": "u-1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await flush();
    expect(mockFire).toHaveBeenCalledTimes(1);
    expect(mockFire).toHaveBeenCalledWith(
      "gitlab",
      expect.objectContaining({ kinds: ["push"], project: "acme/optio", sourceBranch: "main" }),
    );
    expect(mockRedisSet).toHaveBeenCalledWith(
      "optio:webhook-delivery:gitlab:u-1",
      "1",
      "EX",
      expect.any(Number),
      "NX",
    );
    const again = await post({ "x-gitlab-token": GITLAB_SECRET, "x-gitlab-event-uuid": "u-1" });
    expect(again.json()).toEqual({ ok: true, duplicate: true });
    await flush();
    expect(mockFire).toHaveBeenCalledTimes(1);
  });

  it("rejects a wrong or missing token, and everything when the secret is unset", async () => {
    expect((await post({ "x-gitlab-token": "nope" })).statusCode).toBe(401);
    expect((await post({})).statusCode).toBe(401);
    delete process.env.GITLAB_WEBHOOK_SECRET;
    const unset = await post({ "x-gitlab-token": GITLAB_SECRET });
    expect(unset.statusCode).toBe(401);
    expect(unset.json().error).toMatch(/not configured/);
    await flush();
    expect(mockFire).not.toHaveBeenCalled();
  });

  it("acks what nobody automates on without dispatching", async () => {
    const res = await post(
      { "x-gitlab-token": GITLAB_SECRET },
      JSON.stringify({ object_kind: "tag_push", ref: "refs/tags/v1", project: PROJECT }),
    );
    expect(res.statusCode).toBe(200);
    await flush();
    expect(mockFire).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/jira", () => {
  const ISSUE = {
    id: "10001",
    key: "ENG-42",
    self: "https://acme.atlassian.net/rest/api/2/issue/10001",
    fields: {
      summary: "Login broken",
      project: { key: "ENG", name: "Engineering" },
      status: { name: "To Do" },
      labels: [],
    },
  };
  const post = (raw: string, signature?: string) =>
    app.inject({
      method: "POST",
      url: "/api/webhooks/jira",
      headers: {
        "content-type": "application/json",
        ...(signature ? { "x-hub-signature": signature } : {}),
      },
      payload: raw,
    });

  it("verifies X-Hub-Signature and dispatches issue events", async () => {
    const raw = JSON.stringify({
      webhookEvent: "jira:issue_created",
      timestamp: 1700000000000,
      user: { accountId: "a1", displayName: "Alice" },
      issue: ISSUE,
    });
    const res = await post(raw, `sha256=${hex(JIRA_SECRET, raw)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await flush();
    expect(mockFire).toHaveBeenCalledWith(
      "jira",
      expect.objectContaining({ key: "ENG-42", kinds: ["created"] }),
    );
    expect(mockRedisSet).toHaveBeenCalledWith(
      "optio:webhook-delivery:jira:jira:issue_created:10001:1700000000000",
      "1",
      "EX",
      expect.any(Number),
      "NX",
    );
  });

  it("fires a comment once when it arrives both as comment_created and as an issue update", async () => {
    const comment = { id: "77", body: "ping", author: { accountId: "a1", displayName: "Alice" } };
    const asComment = JSON.stringify({ webhookEvent: "comment_created", issue: ISSUE, comment });
    const asUpdate = JSON.stringify({
      webhookEvent: "jira:issue_updated",
      issue_event_type_name: "issue_commented",
      timestamp: 1700000000001,
      user: { accountId: "a1", displayName: "Alice" },
      issue: ISSUE,
      comment,
    });
    expect((await post(asComment, `sha256=${hex(JIRA_SECRET, asComment)}`)).json()).toEqual({
      ok: true,
    });
    expect((await post(asUpdate, `sha256=${hex(JIRA_SECRET, asUpdate)}`)).json()).toEqual({
      ok: true,
      duplicate: true,
    });
    await flush();
    expect(mockFire).toHaveBeenCalledTimes(1);
    expect(mockFire).toHaveBeenCalledWith(
      "jira",
      expect.objectContaining({ kinds: ["commented"], commentBody: "ping" }),
    );
  });

  it("rejects a bad, bare, or missing signature, and everything when the secret is unset", async () => {
    const raw = JSON.stringify({ webhookEvent: "jira:issue_created", issue: ISSUE });
    expect((await post(raw, `sha256=${hex("other", raw)}`)).statusCode).toBe(401);
    expect((await post(raw, hex(JIRA_SECRET, raw))).statusCode).toBe(401);
    expect((await post(raw)).statusCode).toBe(401);
    delete process.env.JIRA_WEBHOOK_SECRET;
    expect((await post(raw, `sha256=${hex(JIRA_SECRET, raw)}`)).statusCode).toBe(401);
    await flush();
    expect(mockFire).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/sentry", () => {
  const issueCreated = JSON.stringify({
    action: "created",
    installation: { uuid: "inst" },
    actor: { type: "application", id: "sentry", name: "Sentry" },
    data: {
      issue: {
        id: "123",
        shortId: "API-1A",
        title: "TypeError",
        culprit: "app/views.py",
        level: "error",
        status: "unresolved",
        project: { id: 1, slug: "api", name: "API" },
        web_url: "https://sentry.io/organizations/acme/issues/123/",
      },
    },
  });
  const post = (raw: string, headers: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: "/api/webhooks/sentry",
      headers: { "content-type": "application/json", ...headers },
      payload: raw,
    });
  const signed = (raw: string, resource: string, stamp = "1700000000") => ({
    "sentry-hook-signature": hex(SENTRY_SECRET, raw),
    "sentry-hook-resource": resource,
    "sentry-hook-timestamp": stamp,
  });

  it("verifies the signature, reads the resource header, and dispatches the issue", async () => {
    const res = await post(issueCreated, signed(issueCreated, "issue"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await flush();
    expect(mockFire).toHaveBeenCalledWith(
      "sentry",
      expect.objectContaining({ kind: "issue_created", shortId: "API-1A", project: "api" }),
    );
    expect(mockRedisSet).toHaveBeenCalledWith(
      "optio:webhook-delivery:sentry:issue:created:123:1700000000",
      "1",
      "EX",
      expect.any(Number),
      "NX",
    );
    // The same delivery again (same timestamp) is a redelivery.
    const again = await post(issueCreated, signed(issueCreated, "issue"));
    expect(again.json()).toEqual({ ok: true, duplicate: true });
    await flush();
    expect(mockFire).toHaveBeenCalledTimes(1);
  });

  it("acks the installation handshake and the error resource without dispatching", async () => {
    const install = JSON.stringify({ action: "created", data: { installation: { uuid: "i" } } });
    expect((await post(install, signed(install, "installation"))).statusCode).toBe(200);
    const error = JSON.stringify({ action: "created", data: { error: { event_id: "e" } } });
    expect((await post(error, signed(error, "error"))).statusCode).toBe(200);
    await flush();
    expect(mockFire).not.toHaveBeenCalled();
  });

  it("rejects a bad or missing signature, and everything when the secret is unset", async () => {
    const forged = await post(issueCreated, {
      ...signed(issueCreated, "issue"),
      "sentry-hook-signature": hex("other", issueCreated),
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error).toBe("Invalid Sentry signature");
    expect((await post(issueCreated, { "sentry-hook-resource": "issue" })).statusCode).toBe(401);
    delete process.env.SENTRY_WEBHOOK_SECRET;
    expect((await post(issueCreated, signed(issueCreated, "issue"))).statusCode).toBe(401);
    await flush();
    expect(mockFire).not.toHaveBeenCalled();
  });
});
