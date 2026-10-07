/**
 * E2E: the signed inbound webhook receivers through the real API server with
 * auth ENABLED (every other e2e suite runs with OPTIO_AUTH_DISABLED=true,
 * which is how a regression that 401'd every GitHub / Slack / Linear delivery
 * slipped through).
 *
 * The receivers can't carry an Optio session — the providers' HMAC is their
 * authentication — so the auth plugin must let POSTs to exactly those paths
 * through, and each receiver must reject unsigned or badly signed deliveries
 * on its own. Everything else under /api/webhooks (outbound-webhook
 * management) stays behind auth.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

const GITHUB_WEBHOOK_SECRET = "e2e-auth-github-secret";
const SLACK_SIGNING_SECRET = "e2e-auth-slack-secret";
const LINEAR_WEBHOOK_SECRET = "e2e-auth-linear-secret";
const PAGERDUTY_WEBHOOK_SECRET = "e2e-auth-pagerduty-secret";
const GITLAB_WEBHOOK_SECRET = "e2e-auth-gitlab-token";
const JIRA_WEBHOOK_SECRET = "e2e-auth-jira-secret";
const SENTRY_WEBHOOK_SECRET = "e2e-auth-sentry-secret";

let server: ApiServerHandle;
let adminToken = "";

/** An admin with a session, seeded straight into the DB (like rbac.e2e). */
async function seedAdmin(): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const wsId = randomUUID();
    const userId = randomUUID();
    adminToken = `e2e-admin-${randomBytes(16).toString("hex")}`;
    const tokenHash = createHash("sha256").update(adminToken).digest("hex");
    await sql`INSERT INTO workspaces (id, name, slug) VALUES (${wsId}, 'Webhook e2e', ${`webhook-e2e-${wsId.slice(0, 8)}`})`;
    await sql`
      INSERT INTO users (id, provider, external_id, email, display_name, default_workspace_id)
      VALUES (${userId}, 'github', 'webhook-e2e-admin', 'admin@webhook.e2e', 'Webhook admin', ${wsId})`;
    await sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${wsId}, ${userId}, 'admin')`;
    await sql`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${userId}, ${tokenHash}, NOW() + INTERVAL '1 day')`;
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await seedAdmin();
  server = await startApiServer({
    env: {
      OPTIO_AUTH_DISABLED: "false",
      GITHUB_WEBHOOK_SECRET,
      SLACK_SIGNING_SECRET,
      LINEAR_WEBHOOK_SECRET,
      PAGERDUTY_WEBHOOK_SECRET,
      GITLAB_WEBHOOK_SECRET,
      JIRA_WEBHOOK_SECRET,
      SENTRY_WEBHOOK_SECRET,
    },
  });
}, 150_000);

afterAll(async () => {
  await server?.stop();
});

async function adminApi<T = any>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

/** POST a raw body with NO Optio credentials — the way a provider delivers. */
async function deliver(
  path: string,
  raw: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${server.baseUrl}${path}`, { method: "POST", headers, body: raw });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function githubHeaders(raw: string, event: string, secret = GITHUB_WEBHOOK_SECRET) {
  return {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": randomUUID(),
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
  };
}

function slackHeaders(raw: string, contentType = "application/json") {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", SLACK_SIGNING_SECRET).update(`v0:${ts}:${raw}`).digest("hex");
  return {
    "content-type": contentType,
    "x-slack-request-timestamp": ts,
    "x-slack-signature": `v0=${sig}`,
  };
}

describe("inbound webhook receivers with auth enabled", () => {
  it("runs the Job a correctly signed GitHub event triggers, and rejects unsigned ones", async () => {
    const repo = `acme/webhook-e2e-${Date.now()}`;
    const created = await adminApi<{ workflow: { id: string } }>("POST", "/api/jobs", {
      name: `issue triage ${Date.now()}`,
      promptTemplate: "Triage {{url}}",
      agentRuntime: "claude-code",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const jobId = created.body.workflow.id;
    const trigger = await adminApi("POST", `/api/jobs/${jobId}/triggers`, {
      type: "github",
      config: { events: ["issue_opened"], repos: [repo] },
    });
    expect(trigger.status, JSON.stringify(trigger.body)).toBe(201);

    const raw = JSON.stringify({
      action: "opened",
      repository: { full_name: repo, html_url: `https://github.com/${repo}` },
      issue: {
        number: 7,
        title: "It is broken",
        body: "Please look",
        html_url: `https://github.com/${repo}/issues/7`,
        user: { login: "alice" },
      },
    });
    const runs = async () =>
      (await adminApi<{ runs: unknown[] }>("GET", `/api/jobs/${jobId}/runs`)).body.runs;

    // Unsigned and badly signed: turned away by the receiver itself (its own
    // messages, not the auth plugin's "Authentication required").
    const unsigned = await deliver("/api/webhooks/github", raw, {
      "content-type": "application/json",
      "x-github-event": "issues",
    });
    expect(unsigned.status).toBe(401);
    expect(unsigned.body.error).toBe("Missing signature");
    const forged = await deliver(
      "/api/webhooks/github",
      raw,
      githubHeaders(raw, "issues", "not-the-secret"),
    );
    expect(forged.status).toBe(401);
    expect(forged.body.error).toBe("Invalid signature");
    expect(await runs()).toHaveLength(0);

    // Correctly signed, still without any Optio credentials: accepted, and
    // the Job listening for it starts a run.
    const signed = await deliver("/api/webhooks/github", raw, githubHeaders(raw, "issues"));
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body).toEqual({ ok: true });
    await waitFor(async () => ((await runs()).length === 1 ? true : null), {
      timeoutMs: 30_000,
      label: "a run of the GitHub-triggered Job",
    });
  });

  it("accepts signed Slack events and rejects unsigned ones", async () => {
    const raw = JSON.stringify({ type: "url_verification", challenge: "e2e-challenge" });
    const signed = await deliver("/api/webhooks/slack/events", raw, slackHeaders(raw));
    expect(signed.status).toBe(200);
    expect(signed.body).toEqual({ challenge: "e2e-challenge" });

    const unsigned = await deliver("/api/webhooks/slack/events", raw, {
      "content-type": "application/json",
    });
    expect(unsigned.status).toBe(401);
    expect(unsigned.body.error).toBe("Invalid Slack signature");
  });

  it("accepts signed Slack button clicks and rejects unsigned ones", async () => {
    const payload = JSON.stringify({
      actions: [{ action_id: "retry_task", value: randomUUID() }],
    });
    const raw = `payload=${encodeURIComponent(payload)}`;
    const form = "application/x-www-form-urlencoded";

    const signed = await deliver("/api/webhooks/slack/actions", raw, slackHeaders(raw, form));
    expect(signed.status).toBe(200);
    expect(signed.body.text).toMatch(/Task not found/);

    const unsigned = await deliver("/api/webhooks/slack/actions", raw, { "content-type": form });
    expect(unsigned.status).toBe(401);
    expect(unsigned.body.error).toBe("Invalid Slack signature");
  });

  it("accepts signed Linear webhooks and rejects unsigned ones", async () => {
    const raw = JSON.stringify({
      type: "Issue",
      action: "update",
      webhookTimestamp: Date.now(),
      data: { id: randomUUID() },
    });
    const sig = createHmac("sha256", LINEAR_WEBHOOK_SECRET).update(raw).digest("hex");
    const signed = await deliver("/api/webhooks/linear", raw, {
      "content-type": "application/json",
      "linear-signature": sig,
    });
    expect(signed.status).toBe(200);
    expect(signed.body).toEqual({ ok: true });

    const unsigned = await deliver("/api/webhooks/linear", raw, {
      "content-type": "application/json",
    });
    expect(unsigned.status).toBe(401);
    expect(unsigned.body.error).toBe("Invalid Linear signature");
  });

  it("runs the Job a signed PagerDuty incident triggers, and rejects unsigned ones", async () => {
    const created = await adminApi<{ workflow: { id: string } }>("POST", "/api/jobs", {
      name: `incident triage ${Date.now()}`,
      promptTemplate: "Investigate {{title}} ({{service}}): {{url}}",
      agentRuntime: "claude-code",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const jobId = created.body.workflow.id;
    const service = `Checkout ${Date.now()}`;
    const trigger = await adminApi("POST", `/api/jobs/${jobId}/triggers`, {
      type: "pagerduty",
      config: { events: ["incident.triggered"], services: [service] },
    });
    expect(trigger.status, JSON.stringify(trigger.body)).toBe(201);

    const raw = JSON.stringify({
      event: {
        id: randomUUID(),
        event_type: "incident.triggered",
        data: {
          id: `P${Date.now().toString(36).toUpperCase()}`,
          incident_number: 3,
          title: "Checkout latency",
          html_url: "https://acme.pagerduty.com/incidents/P1",
          urgency: "high",
          status: "triggered",
          service: { id: "PSVC1", summary: service },
          assignees: [{ summary: "Alice" }],
        },
      },
    });
    const runs = async () =>
      (await adminApi<{ runs: unknown[] }>("GET", `/api/jobs/${jobId}/runs`)).body.runs;

    const unsigned = await deliver("/api/webhooks/pagerduty", raw, {
      "content-type": "application/json",
      "x-webhook-id": randomUUID(),
    });
    expect(unsigned.status).toBe(401);
    expect(unsigned.body.error).toBe("Invalid PagerDuty signature");
    const forged = await deliver("/api/webhooks/pagerduty", raw, {
      "content-type": "application/json",
      "x-webhook-id": randomUUID(),
      "x-pagerduty-signature": `v1=${createHmac("sha256", "not-the-secret").update(raw).digest("hex")}`,
    });
    expect(forged.status).toBe(401);
    expect(await runs()).toHaveLength(0);

    const signed = await deliver("/api/webhooks/pagerduty", raw, {
      "content-type": "application/json",
      "x-webhook-id": randomUUID(),
      "x-pagerduty-signature": `v1=${createHmac("sha256", PAGERDUTY_WEBHOOK_SECRET).update(raw).digest("hex")}`,
    });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body).toEqual({ ok: true });
    await waitFor(async () => ((await runs()).length === 1 ? true : null), {
      timeoutMs: 30_000,
      label: "a run of the PagerDuty-triggered Job",
    });
  });

  it("runs a Pylon-triggered Job made through /api/work: the secret is shown once, then checked", async () => {
    const created = await adminApi<{
      kind: string;
      id: string;
      trigger?: { id: string; secret?: string };
    }>("POST", "/api/work", {
      name: `pylon triage ${Date.now()}`,
      when: { type: "pylon", config: { events: ["issue.created"] } },
      where: { runTarget: "cluster" },
      who: { runtime: "claude-code" },
      what: { prompt: "Look at {{title}} for {{account}}: {{url}}" },
      then: "exits",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.kind).toBe("standalone");
    const jobId = created.body.id;
    const triggerId = created.body.trigger?.id;
    const secret = created.body.trigger?.secret;
    expect(triggerId).toBeTruthy();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/);

    // Every read says only that there is one.
    const listed = await adminApi<{ triggers: { id: string; config: Record<string, unknown> }[] }>(
      "GET",
      `/api/work/${jobId}/triggers`,
    );
    expect(listed.status).toBe(200);
    const shown = listed.body.triggers.find((t) => t.id === triggerId)!;
    expect(shown.config).toEqual({ events: ["issue.created"], hasSecret: true });
    const viaJobs = await adminApi<{ triggers: { config: Record<string, unknown> }[] }>(
      "GET",
      `/api/jobs/${jobId}/triggers`,
    );
    expect(viaJobs.body.triggers[0].config).not.toHaveProperty("secret");

    const raw = JSON.stringify({
      event: "issue.created",
      issue: {
        id: "iss_e2e",
        number: 12,
        title: "Login broken",
        link: "https://app.usepylon.com/issues/12",
        account: { name: "Acme" },
      },
    });
    const runs = async () =>
      (await adminApi<{ runs: unknown[] }>("GET", `/api/jobs/${jobId}/runs`)).body.runs;

    const wrong = await deliver(`/api/hooks/pylon/${triggerId}`, raw, {
      "content-type": "application/json",
      "x-optio-secret": "not-it",
    });
    expect(wrong.status).toBe(401);
    const missing = await deliver(`/api/hooks/pylon/${triggerId}`, raw, {
      "content-type": "application/json",
    });
    expect(missing.status).toBe(401);
    expect(await runs()).toHaveLength(0);

    const filtered = await deliver(
      `/api/hooks/pylon/${triggerId}`,
      JSON.stringify({ event: "issue.closed" }),
      { "content-type": "application/json", "x-optio-secret": secret! },
    );
    expect(filtered.status).toBe(202);
    expect(filtered.body).toEqual({ matched: false });

    const accepted = await deliver(`/api/hooks/pylon/${triggerId}`, raw, {
      "content-type": "application/json",
      "x-optio-secret": secret!,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    expect(accepted.body.runId).toBeTruthy();
    await waitFor(async () => ((await runs()).length === 1 ? true : null), {
      timeoutMs: 30_000,
      label: "a run of the Pylon-triggered Job",
    });
  });

  it("runs the Job a GitLab push with the right token triggers, and rejects the wrong one", async () => {
    const project = `acme/gitlab-e2e-${Date.now()}`;
    const created = await adminApi<{ workflow: { id: string } }>("POST", "/api/jobs", {
      name: `push summary ${Date.now()}`,
      promptTemplate: "Summarize {{commits}} on {{sourceBranch}} ({{compareUrl}})",
      agentRuntime: "claude-code",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const jobId = created.body.workflow.id;
    const trigger = await adminApi("POST", `/api/jobs/${jobId}/triggers`, {
      type: "gitlab",
      config: { events: ["push"], projects: [project], branches: ["main"] },
    });
    expect(trigger.status, JSON.stringify(trigger.body)).toBe(201);

    const raw = JSON.stringify({
      object_kind: "push",
      ref: "refs/heads/main",
      before: "aaaa1111",
      after: "bbbb2222",
      user_username: "alice",
      project: { path_with_namespace: project, web_url: `https://gitlab.com/${project}` },
      commits: [{ id: "bbbb2222", title: "fix: thing", message: "fix: thing" }],
    });
    const runs = async () =>
      (await adminApi<{ runs: unknown[] }>("GET", `/api/jobs/${jobId}/runs`)).body.runs;

    const untoken = await deliver("/api/webhooks/gitlab", raw, {
      "content-type": "application/json",
      "x-gitlab-event": "Push Hook",
      "x-gitlab-event-uuid": randomUUID(),
    });
    expect(untoken.status).toBe(401);
    expect(untoken.body.error).toBe("Invalid X-Gitlab-Token");
    const wrong = await deliver("/api/webhooks/gitlab", raw, {
      "content-type": "application/json",
      "x-gitlab-event-uuid": randomUUID(),
      "x-gitlab-token": "not-the-token",
    });
    expect(wrong.status).toBe(401);
    expect(await runs()).toHaveLength(0);

    const ok = await deliver("/api/webhooks/gitlab", raw, {
      "content-type": "application/json",
      "x-gitlab-event-uuid": randomUUID(),
      "x-gitlab-token": GITLAB_WEBHOOK_SECRET,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    await waitFor(async () => ((await runs()).length === 1 ? true : null), {
      timeoutMs: 30_000,
      label: "a run of the GitLab-triggered Job",
    });
  });

  it("accepts signed Jira webhooks and rejects unsigned ones", async () => {
    const raw = JSON.stringify({
      webhookEvent: "jira:issue_created",
      timestamp: Date.now(),
      user: { accountId: "a1", displayName: "Alice" },
      issue: {
        id: "30001",
        key: "E2E-1",
        self: "https://acme.atlassian.net/rest/api/2/issue/30001",
        fields: { summary: "It is broken", project: { key: "E2E", name: "E2E" }, labels: [] },
      },
    });
    const unsigned = await deliver("/api/webhooks/jira", raw, {
      "content-type": "application/json",
    });
    expect(unsigned.status).toBe(401);
    expect(unsigned.body.error).toBe("Invalid Jira signature");
    const forged = await deliver("/api/webhooks/jira", raw, {
      "content-type": "application/json",
      "x-hub-signature": `sha256=${createHmac("sha256", "not-the-secret").update(raw).digest("hex")}`,
    });
    expect(forged.status).toBe(401);
    const signed = await deliver("/api/webhooks/jira", raw, {
      "content-type": "application/json",
      "x-hub-signature": `sha256=${createHmac("sha256", JIRA_WEBHOOK_SECRET).update(raw).digest("hex")}`,
    });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body).toEqual({ ok: true });
  });

  it("runs the Job a signed Sentry issue triggers, and rejects unsigned ones", async () => {
    const project = `sentry-e2e-${Date.now()}`;
    const created = await adminApi<{ workflow: { id: string } }>("POST", "/api/jobs", {
      name: `sentry triage ${Date.now()}`,
      promptTemplate: "Look at {{shortId}} {{title}} in {{project}}: {{url}}",
      agentRuntime: "claude-code",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const jobId = created.body.workflow.id;
    const trigger = await adminApi("POST", `/api/jobs/${jobId}/triggers`, {
      type: "sentry",
      config: { events: ["issue_created"], projects: [project], levels: ["error", "fatal"] },
    });
    expect(trigger.status, JSON.stringify(trigger.body)).toBe(201);

    const raw = JSON.stringify({
      action: "created",
      installation: { uuid: randomUUID() },
      actor: { type: "application", id: "sentry", name: "Sentry" },
      data: {
        issue: {
          id: String(Date.now()),
          shortId: "E2E-1A",
          title: "TypeError: x",
          culprit: "app",
          level: "error",
          status: "unresolved",
          project: { id: 1, slug: project, name: "E2E" },
          web_url: "https://sentry.io/organizations/acme/issues/1/",
        },
      },
    });
    const runs = async () =>
      (await adminApi<{ runs: unknown[] }>("GET", `/api/jobs/${jobId}/runs`)).body.runs;
    const headers = (signature: string) => ({
      "content-type": "application/json",
      "sentry-hook-resource": "issue",
      "sentry-hook-timestamp": String(Date.now()),
      "sentry-hook-signature": signature,
    });

    const unsigned = await deliver("/api/webhooks/sentry", raw, {
      "content-type": "application/json",
      "sentry-hook-resource": "issue",
    });
    expect(unsigned.status).toBe(401);
    expect(unsigned.body.error).toBe("Invalid Sentry signature");
    const forged = await deliver(
      "/api/webhooks/sentry",
      raw,
      headers(createHmac("sha256", "not-the-secret").update(raw).digest("hex")),
    );
    expect(forged.status).toBe(401);
    expect(await runs()).toHaveLength(0);

    const signed = await deliver(
      "/api/webhooks/sentry",
      raw,
      headers(createHmac("sha256", SENTRY_WEBHOOK_SECRET).update(raw).digest("hex")),
    );
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body).toEqual({ ok: true });
    await waitFor(async () => ((await runs()).length === 1 ? true : null), {
      timeoutMs: 30_000,
      label: "a run of the Sentry-triggered Job",
    });
  });

  it("runs an Alertmanager-triggered Job made through /api/work: the secret is shown once, then checked as Bearer or basic auth", async () => {
    const created = await adminApi<{
      kind: string;
      id: string;
      trigger?: { id: string; secret?: string };
    }>("POST", "/api/work", {
      name: `alerts ${Date.now()}`,
      when: { type: "alertmanager", config: { events: ["firing"], severities: ["critical"] } },
      where: { runTarget: "cluster" },
      who: { runtime: "claude-code" },
      what: { prompt: "Investigate {{alertnames}}: {{message}}" },
      then: "exits",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.kind).toBe("standalone");
    const jobId = created.body.id;
    const triggerId = created.body.trigger?.id;
    const secret = created.body.trigger?.secret;
    expect(triggerId).toBeTruthy();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const listed = await adminApi<{ triggers: { id: string; config: Record<string, unknown> }[] }>(
      "GET",
      `/api/work/${jobId}/triggers`,
    );
    expect(listed.body.triggers.find((t) => t.id === triggerId)!.config).toEqual({
      events: ["firing"],
      severities: ["critical"],
      hasSecret: true,
    });

    const group = (severity: string) =>
      JSON.stringify({
        version: "4",
        status: "firing",
        receiver: "optio",
        groupKey: '{}:{alertname="HighLatency"}',
        commonLabels: { alertname: "HighLatency", severity },
        alerts: [
          {
            status: "firing",
            labels: { alertname: "HighLatency", severity, instance: "web-1" },
            annotations: { summary: "p99 over 2s" },
            fingerprint: "f1",
          },
        ],
      });
    const runs = async () =>
      (await adminApi<{ runs: unknown[] }>("GET", `/api/jobs/${jobId}/runs`)).body.runs;

    const wrong = await deliver(`/api/hooks/alertmanager/${triggerId}`, group("critical"), {
      "content-type": "application/json",
      authorization: "Bearer not-it",
    });
    expect(wrong.status).toBe(401);
    const missing = await deliver(`/api/hooks/alertmanager/${triggerId}`, group("critical"), {
      "content-type": "application/json",
    });
    expect(missing.status).toBe(401);
    const filtered = await deliver(`/api/hooks/alertmanager/${triggerId}`, group("warning"), {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`optio:${secret}`).toString("base64")}`,
    });
    expect(filtered.status).toBe(202);
    expect(filtered.body).toEqual({ matched: false });
    expect(await runs()).toHaveLength(0);

    const accepted = await deliver(`/api/hooks/alertmanager/${triggerId}`, group("critical"), {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    expect(accepted.body.runId).toBeTruthy();
    await waitFor(async () => ((await runs()).length === 1 ? true : null), {
      timeoutMs: 30_000,
      label: "a run of the Alertmanager-triggered Job",
    });
  });

  it("keeps outbound webhook management behind auth", async () => {
    for (const [method, path] of [
      ["GET", "/api/webhooks"],
      ["POST", "/api/webhooks"],
      ["GET", "/api/webhooks/github"],
      ["DELETE", "/api/webhooks/linear"],
      ["GET", `/api/webhooks/${randomUUID()}/deliveries`],
    ] as const) {
      // A valid body, so schema validation (which runs before the auth
      // preHandler) passes and the request reaches the auth check.
      const body = { url: "https://hooks.example.com/optio", events: ["task.completed"] };
      const res = await fetch(`${server.baseUrl}${path}`, {
        method,
        ...(method === "POST"
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe("Authentication required");
    }
    const authed = await adminApi("GET", "/api/webhooks");
    expect(authed.status).toBe(200);
  });
});
