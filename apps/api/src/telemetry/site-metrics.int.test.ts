/**
 * The Prometheus endpoint end to end (docs/observability.md "Prometheus
 * endpoint and dashboard"): OPTIO_METRICS_PORT set and OTLP off, the API's telemetry
 * starts a listener; the fork's gauges read this file's database (runs, agent
 * pods, credential health, ticket providers, remote-workspace starts, the month's
 * spend), its counters follow real code paths (a Job run failing on a
 * gateway 429, a task failing, GitLab answering 401), and a scrape over HTTP
 * shows them next to upstream's own metrics.
 */
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { TaskState, WorkflowRunState } from "@optio/shared";
import { db } from "../db/client.js";
import {
  agentPods,
  apiKeys,
  credentialChecks,
  localHosts,
  teams,
  ticketProviders,
  ticketWritebacks,
  users,
} from "../db/schema.js";
import {
  insertTask,
  insertWorkflow,
  insertWorkflowRun,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";

// The reconciler isn't this file's subject: the transitions' wake-ups go nowhere.
vi.mock("../services/reconcile-queue.js", () => ({
  RECONCILE_QUEUE_NAME: "reconcile",
  reconcileQueue: { add: vi.fn(), close: vi.fn() },
  enqueueReconcile: vi.fn(async () => {}),
}));

const uniq = () => randomBytes(4).toString("hex");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** The value of the one series of `name` that has every label in `labels`, or undefined. */
function valueOf(
  text: string,
  name: string,
  labels: Record<string, string> = {},
): number | undefined {
  const want = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    const m = line.match(/^[^{ ]+(?:\{(.*)\})? (\S+)$/);
    if (m && want.every((w) => (m[1] ?? "").split(",").includes(w))) return Number(m[2]);
  }
  return undefined;
}

let port = 0;
let text = "";
let personId = "";
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

beforeAll(async () => {
  port = await freePort();
  vi.stubEnv("OPTIO_METRICS_PORT", String(port));
  vi.stubEnv("OPTIO_OTEL_ENABLED", "");
  const { initTelemetry, registerMetricCallbacks } = await import("../telemetry.js");
  await initTelemetry();

  // ── What the gauges will read ──────────────────────────────────────────
  const ws = await insertWorkspace({ slug: `acme-${uniq()}` });
  const [team] = await db
    .insert(teams)
    .values({ workspaceId: ws.id, name: "Platform", slug: `platform-${uniq()}` })
    .returning();
  const [person] = await db
    .insert(users)
    .values({
      provider: "ldap",
      externalId: `ext-${uniq()}`,
      email: `p-${uniq()}@example.test`,
      displayName: "Pat",
    })
    .returning();
  personId = person.id;

  // A repo task stuck in queued for 40 minutes, one running, one owned by the team.
  await insertTask({ state: "queued", workspaceId: ws.id, updatedAt: minutesAgo(40) });
  await insertTask({ state: "running", workspaceId: ws.id });
  const teamTask = await insertTask({
    state: "running",
    workspaceId: ws.id,
    ownerTeamId: team.id,
    ownerUserId: person.id,
  });
  await db.insert(agentPods).values({
    pool: "standalone",
    poolKey: `job-${uniq()}`,
    state: "provisioning",
    updatedAt: minutesAgo(20),
  });
  await db.insert(credentialChecks).values([
    {
      credentialKey: `gitlab:user:${person.id}`,
      kind: "gitlab",
      label: "GitLab token",
      scope: "person",
      userId: person.id,
      status: "error",
      reason: "GitLab at gitlab.example.test refused it (401)",
    },
    {
      credentialKey: `gateway:x:team:${team.id}`,
      kind: "gateway",
      label: "Gateway token",
      scope: "team",
      teamId: team.id,
      status: "warning",
      expiresAt: new Date(Date.now() + 3 * 86_400_000),
    },
  ]);
  const [provider] = await db
    .insert(ticketProviders)
    .values({
      source: "jira",
      config: { baseUrl: "https://jira.example.test/jira", token: "never-shown" },
      consecutiveFailures: 3,
      workspaceId: ws.id,
    })
    .returning();
  await db.insert(ticketWritebacks).values({
    dedupeKey: `${teamTask.id}:started`,
    taskId: teamTask.id,
    providerId: provider.id,
    ticketSource: "jira",
    ticketExternalId: "PLAT-1",
    event: "started",
    status: "failed",
    attempts: 2,
  });
  // A remote workspace (Coder) Optio started 6 minutes ago that hasn't paired yet.
  const [key] = await db
    .insert(apiKeys)
    .values({
      userId: person.id,
      name: "coder:ws",
      prefix: "optio_pat_it",
      hashedKey: `hash-${uniq()}`,
      createdAt: minutesAgo(6),
    })
    .returning();
  const [coderHost] = await db
    .insert(localHosts)
    .values({
      name: "coder ws",
      hostname: "coder-ws",
      platform: "linux",
      userId: person.id,
      origin: "coder",
      pairingTokenId: key.id,
    })
    .returning();
  // This month's spend on the team's work, as the ledger records it.
  await db.execute(sql`
    INSERT INTO usage_ledger (source_kind, source_id, workspace_id, owner_user_id, subject_id,
      subject_kind, subject_name, work_id, work_name, href, model, cost_usd, cost_basis)
    VALUES ('tasks', ${teamTask.id}::uuid, ${ws.id}::uuid, ${person.id}::uuid, ${teamTask.id}::uuid,
      'work', 'it', ${teamTask.id}::uuid, 'it', '/work/x', 'it-model', 1.25, 'reported')`);

  // ── Metrics on, as index.ts does once the database is up ───────────────
  await registerMetricCallbacks({
    queueDepth: (attrs) => (attrs.state === "queued" ? 7 : 0),
    activeTasks: () => 3,
    podCount: () => 0,
  });
  const { refreshSiteMetrics } = await import("./site-metrics.js");
  await refreshSiteMetrics({ force: true });

  // ── What happens, through the real code ────────────────────────────────
  const workflowService = await import("../services/workflow-service.js");
  const job = await insertWorkflow({
    workspaceId: ws.id,
    ownerTeamId: team.id,
    ownerUserId: person.id,
  });
  const run = await insertWorkflowRun(job.id, { state: "running", ownerTeamId: team.id });
  const failed = await workflowService.transitionWorkflowRunCas(
    run.id,
    WorkflowRunState.RUNNING,
    WorkflowRunState.FAILED,
    {
      errorMessage: 'API Error: 429 {"error":{"message":"Budget has been exceeded"}}',
      modelUsed: "it-model",
    },
    { wakeReconciler: false },
  );
  expect(failed?.state).toBe("failed");
  const taskService = await import("../services/task-service.js");
  const doomed = await insertTask({ state: "running", workspaceId: ws.id });
  await taskService.transitionTask(doomed.id, TaskState.FAILED, "it", "exit code 1");

  const { GitLabPlatform } = await import("../services/git-platform/gitlab.js");
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("401 Unauthorized", { status: 401 }));
  await expect(
    new GitLabPlatform("glpat-never-shown").getPullRequest(
      {
        platform: "gitlab",
        host: "gitlab.example.test",
        owner: "platform",
        repo: "app",
        apiBaseUrl: "https://gitlab.example.test/api/v4",
      } as never,
      1,
    ),
  ).rejects.toThrow("GitLab API error 401");
  spy.mockRestore();

  // The workspace's daemon says hello (ws/local-daemon.ts): its start took
  // about 6 minutes. A reconnect (seen since its token was minted) isn't a start.
  const { noteRemoteWorkspaceHello } = await import("../services/remote-workspace-service.js");
  await noteRemoteWorkspaceHello(coderHost);
  await noteRemoteWorkspaceHello({ ...coderHost, lastSeenAt: new Date() });

  const res = await fetch(`http://127.0.0.1:${port}/metrics`);
  expect(res.status).toBe(200);
  text = await res.text();
}, 60_000);

afterAll(async () => {
  const { stopSiteMetrics } = await import("./site-metrics.js");
  stopSiteMetrics();
  const { shutdownTelemetry } = await import("../telemetry.js");
  await shutdownTelemetry();
  // What the transitions announce in the background (notifications) settles first.
  await new Promise((r) => setTimeout(r, 300));
  const { getRedisClient } = await import("../services/event-bus.js");
  await getRedisClient().quit();
  vi.unstubAllEnvs();
});

describe("GET /metrics on OPTIO_METRICS_PORT", () => {
  it("serves only /metrics on its own port", async () => {
    const other = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(other.status).toBe(404);
    await other.text();
  });

  it("shows runs by kind and state, and how long the oldest has queued", () => {
    expect(valueOf(text, "optio_runs", { kind: "repo", state: "queued" })).toBe(1);
    expect(valueOf(text, "optio_runs", { kind: "repo", state: "running" })).toBe(2);
    expect(valueOf(text, "optio_runs", { kind: "standalone", state: "queued" })).toBe(0);
    const oldest = valueOf(text, "optio_run_oldest_seconds", { kind: "repo", state: "queued" });
    expect(oldest).toBeGreaterThanOrEqual(39 * 60);
    expect(oldest).toBeLessThan(45 * 60);
  });

  it("shows agent pods stuck provisioning, credential health, ticket providers and remote-workspace starts and their times", () => {
    expect(valueOf(text, "optio_agent_pods", { pool: "standalone", state: "provisioning" })).toBe(
      1,
    );
    expect(
      valueOf(text, "optio_agent_pod_oldest_provisioning_seconds", { pool: "standalone" }),
    ).toBeGreaterThanOrEqual(19 * 60);
    expect(
      valueOf(text, "optio_credentials", { kind: "gitlab", scope: "person", status: "error" }),
    ).toBe(1);
    expect(valueOf(text, "optio_credentials_expiring", { kind: "gateway", scope: "team" })).toBe(1);
    expect(
      valueOf(text, "optio_ticket_provider_consecutive_failures", {
        source: "jira",
        host: "jira.example.test",
        enabled: "true",
      }),
    ).toBe(3);
    expect(
      valueOf(text, "optio_ticket_writebacks_open", { source: "jira", status: "failed" }),
    ).toBe(1);
    const coder = { provider: "coder" };
    expect(valueOf(text, "optio_remote_workspaces_starting", coder)).toBe(1);
    expect(
      valueOf(text, "optio_remote_workspace_start_wait_seconds", coder),
    ).toBeGreaterThanOrEqual(5 * 60);
    expect(valueOf(text, "optio_remote_workspace_start_seconds_count", coder)).toBe(1);
    const took = valueOf(text, "optio_remote_workspace_start_seconds_sum", coder) ?? 0;
    expect(took).toBeGreaterThanOrEqual(6 * 60);
    expect(took).toBeLessThan(7 * 60);
  });

  it("shows this month's gateway spend by team and model", () => {
    expect(
      valueOf(text, "optio_gateway_spend_usd", {
        owner: "team",
        team: "Platform",
        model: "it-model",
      }),
    ).toBe(1.25);
  });

  it("counts runs that ended, the gateway's 429 a Job run failed on, and GitLab's 401", () => {
    expect(
      valueOf(text, "optio_runs_finished_total", { kind: "standalone", state: "failed" }),
    ).toBe(1);
    expect(valueOf(text, "optio_runs_finished_total", { kind: "repo", state: "failed" })).toBe(1);
    expect(
      valueOf(text, "optio_gateway_errors_total", {
        status: "429",
        model: "it-model",
        source: "run",
        owner: "team",
        team: "Platform",
      }),
    ).toBe(1);
    expect(
      valueOf(text, "optio_gitlab_api_errors_total", {
        host: "gitlab.example.test",
        status: "401",
      }),
    ).toBe(1);
  });

  it("serves upstream's metrics on the same endpoint", () => {
    expect(valueOf(text, "optio_queue_depth", { state: "queued" })).toBe(7);
    expect(valueOf(text, "optio_active_tasks")).toBe(3);
    expect(valueOf(text, "optio_state_transitions_total", { from: "running", to: "failed" })).toBe(
      1,
    );
    expect(valueOf(text, "optio_metrics_refreshed_timestamp_seconds")).toBeGreaterThan(0);
  });

  it("never shows a secret, a person or an error text", () => {
    for (const leak of [
      "never-shown",
      "glpat",
      "@example.test",
      personId,
      "Budget has been exceeded",
      "refused it",
      "PLAT-1",
    ]) {
      expect(text).not.toContain(leak);
    }
  });
});
