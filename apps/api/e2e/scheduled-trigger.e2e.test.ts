/**
 * E2E: trigger firing (schedule + webhook) through the real API server.
 *
 * Covers: POST /api/tasks/:id/triggers (unified route) creating a schedule
 * trigger with a computed nextFireAt → workflow-trigger-worker poll cycle
 * (OPTIO_WORKFLOW_TRIGGER_INTERVAL=2000 from the e2e harness) fires the
 * trigger → workflow run created with triggerId → fake agent completes it →
 * markTriggerFired advances nextFireAt + stamps lastFiredAt. Also: disabled
 * triggers are skipped by the due-query, webhook ingress via
 * POST /api/hooks/:path (including HMAC secret enforcement), and the legacy
 * /api/jobs/:id/triggers route computing nextFireAt for schedule triggers
 * just like the unified route (it used to leave it null — such triggers
 * never fired).
 *
 * cron-parser supports 6-field (seconds) expressions, so schedule triggers
 * here use every-2-seconds crons to become due within ~2s instead of waiting
 * out a minute boundary.
 */
import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let server: ApiServerHandle;
// Direct connection to this file's private DB — used only where the HTTP API
// cannot express a state (see the disabled-trigger test).
let sql: postgres.Sql;

beforeAll(async () => {
  server = await startApiServer();
  sql = postgres(process.env.DATABASE_URL!);
}, 150_000);

afterAll(async () => {
  await sql?.end();
  await server?.stop();
});

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  return { status: res.status, body: (await res.json()) as T };
}

interface Trigger {
  id: string;
  targetType: string;
  targetId: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown> | null;
  lastFiredAt: string | null;
  nextFireAt: string | null;
}

interface Run {
  id: string;
  workflowId: string;
  triggerId: string | null;
  state: string;
  params: Record<string, unknown> | null;
  costUsd: string | null;
}

async function createJob(name: string, promptTemplate: string): Promise<string> {
  const { status, body } = await api<{ workflow: { id: string } }>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ name, promptTemplate, agentRuntime: "claude-code" }),
  });
  expect(status).toBe(201);
  return body.workflow.id;
}

/** Create a trigger via the unified /api/tasks/:id/triggers route. */
async function createTrigger(workflowId: string, input: Record<string, unknown>): Promise<Trigger> {
  const { status, body } = await api<{ trigger: Trigger }>(`/api/tasks/${workflowId}/triggers`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  expect(status).toBe(201);
  return body.trigger;
}

async function listRuns(workflowId: string): Promise<Run[]> {
  const { status, body } = await api<{ runs: Run[] }>(`/api/jobs/${workflowId}/runs`);
  expect(status).toBe(200);
  return body.runs;
}

async function getTrigger(workflowId: string, triggerId: string): Promise<Trigger> {
  const { status, body } = await api<{ triggers: Trigger[] }>(`/api/jobs/${workflowId}/triggers`);
  expect(status).toBe(200);
  const trigger = body.triggers.find((t) => t.id === triggerId);
  expect(trigger).toBeDefined();
  return trigger!;
}

async function disableTrigger(workflowId: string, triggerId: string): Promise<Trigger> {
  const { status, body } = await api<{ trigger: Trigger }>(
    `/api/tasks/${workflowId}/triggers/${triggerId}`,
    { method: "PATCH", body: JSON.stringify({ enabled: false }) },
  );
  expect(status).toBe(200);
  return body.trigger;
}

async function waitForRunState(runId: string, states: string[]): Promise<Run> {
  return waitFor(
    async () => {
      const { body } = await api<{ run: Run }>(`/api/workflow-runs/${runId}`);
      return states.includes(body.run.state) ? body.run : null;
    },
    { timeoutMs: 90_000, label: `run ${runId} → ${states.join("|")}` },
  );
}

describe("scheduled trigger e2e", () => {
  it("fires a due schedule trigger, completes the run, and advances nextFireAt", async () => {
    const workflowId = await createJob("e2e schedule job", "Say hello on a schedule");

    // Anchor the clock BEFORE creation: nextFireAt is computed strictly after
    // server-now at creation time, so beforeCreate is a latency-immune lower
    // bound (an after-the-fact Date.now() lower bound flakes on slow requests).
    const beforeCreate = Date.now();
    const trigger = await createTrigger(workflowId, {
      type: "schedule",
      config: { cronExpression: "*/2 * * * * *" },
    });
    expect(trigger.enabled).toBe(true);
    expect(trigger.targetType).toBe("job");
    expect(trigger.targetId).toBe(workflowId);
    // createWorkflowTrigger computes nextFireAt from the cron expression at
    // creation: the next 2s boundary — after beforeCreate, at most ~2s past
    // the (post-request) clock.
    expect(trigger.nextFireAt).not.toBeNull();
    const initialNextFireAt = new Date(trigger.nextFireAt!);
    expect(initialNextFireAt.getTime()).toBeGreaterThan(beforeCreate - 1_000);
    expect(initialNextFireAt.getTime()).toBeLessThanOrEqual(Date.now() + 3_000);

    // The poller (every 2s in the e2e harness) should fire it and create a run.
    const firedRun = await waitFor(
      async () => {
        const runs = await listRuns(workflowId);
        return runs.find((r) => r.triggerId === trigger.id) ?? null;
      },
      { timeoutMs: 60_000, label: `schedule trigger ${trigger.id} fires a run` },
    );

    // markTriggerFired stamps lastFiredAt and advances nextFireAt past the
    // originally computed value (it fires dispatch first, so poll briefly).
    const fired = await waitFor(
      async () => {
        const t = await getTrigger(workflowId, trigger.id);
        return t.lastFiredAt !== null &&
          t.nextFireAt !== null &&
          new Date(t.nextFireAt).getTime() > initialNextFireAt.getTime()
          ? t
          : null;
      },
      { timeoutMs: 15_000, label: "lastFiredAt set and nextFireAt advanced" },
    );
    expect(fired.lastFiredAt).not.toBeNull();
    expect(new Date(fired.nextFireAt!).getTime()).toBeGreaterThan(initialNextFireAt.getTime());

    // Stop the every-2s cron from piling up more runs. Disabling a schedule
    // trigger nulls its nextFireAt (updateWorkflowTrigger recomputes).
    const disabled = await disableTrigger(workflowId, trigger.id);
    expect(disabled.enabled).toBe(false);
    expect(disabled.nextFireAt).toBeNull();

    // The fired run completes via the fake agent with the default mock cost.
    const run = await waitForRunState(firedRun.id, ["completed", "failed"]);
    expect(run.state).toBe("completed");
    expect(run.costUsd).toBe("0.0123");
    expect(run.triggerId).toBe(trigger.id);
  }, 150_000);

  it("does not fire disabled triggers or triggers without a nextFireAt", async () => {
    // Disabled trigger. The API nulls nextFireAt for disabled schedule
    // triggers, which would make "it never fires" vacuous — so backdate
    // next_fire_at directly in the DB (the API cannot express a due-but-
    // disabled trigger). Now only the enabled=true filter in
    // getDueScheduleTriggersAll() prevents firing.
    const disabledWorkflowId = await createJob("e2e disabled trigger job", "Should never run");
    const disabledTrigger = await createTrigger(disabledWorkflowId, {
      type: "schedule",
      config: { cronExpression: "* * * * * *" },
      enabled: false,
    });
    expect(disabledTrigger.enabled).toBe(false);
    // Actual behavior: nextFireAt is only computed for enabled schedule triggers.
    expect(disabledTrigger.nextFireAt).toBeNull();
    await sql`
      UPDATE workflow_triggers SET next_fire_at = now() - interval '1 hour'
      WHERE id = ${disabledTrigger.id}
    `;

    // Legacy /api/jobs/:id/triggers route: its createTrigger computes
    // nextFireAt exactly like the unified route (regression: it used to leave
    // it null, so schedule triggers created there never fired). A daily cron
    // anchored ~12h out keeps the computed nextFireAt far from due, so the
    // poller can't fire it before we null the value below.
    const cronAnchor = new Date(Date.now() + 12 * 60 * 60 * 1000);
    const legacyWorkflowId = await createJob("e2e legacy trigger job", "Should never run either");
    const legacyRes = await api<{ trigger: Trigger }>(`/api/jobs/${legacyWorkflowId}/triggers`, {
      method: "POST",
      body: JSON.stringify({
        type: "schedule",
        config: {
          cronExpression: `${cronAnchor.getUTCMinutes()} ${cronAnchor.getUTCHours()} * * *`,
        },
      }),
    });
    expect(legacyRes.status).toBe(201);
    expect(legacyRes.body.trigger.enabled).toBe(true);
    expect(legacyRes.body.trigger.nextFireAt).not.toBeNull();
    const legacyNextFireAt = new Date(legacyRes.body.trigger.nextFireAt!).getTime();
    expect(legacyNextFireAt).toBeGreaterThan(Date.now());
    expect(legacyNextFireAt).toBeLessThanOrEqual(cronAnchor.getTime() + 24 * 60 * 60 * 1000);

    // The API can no longer produce a nextFireAt-less enabled schedule
    // trigger — null it directly to pin the due-query's NULL handling.
    await sql`
      UPDATE workflow_triggers SET next_fire_at = NULL
      WHERE id = ${legacyRes.body.trigger.id}
    `;

    // Canary: an enabled, due schedule trigger created AFTER both of the
    // above. When it fires and its run completes, the poller has demonstrably
    // evaluated the due-set several times while both non-firing triggers sat
    // in the table — no blind sleep needed.
    const canaryWorkflowId = await createJob("e2e canary job", "Canary run");
    const canaryTrigger = await createTrigger(canaryWorkflowId, {
      type: "schedule",
      config: { cronExpression: "*/2 * * * * *" },
    });
    const canaryRun = await waitFor(
      async () => {
        const runs = await listRuns(canaryWorkflowId);
        return runs.find((r) => r.triggerId === canaryTrigger.id) ?? null;
      },
      { timeoutMs: 60_000, label: "canary schedule trigger fires" },
    );
    await disableTrigger(canaryWorkflowId, canaryTrigger.id);
    const finishedCanary = await waitForRunState(canaryRun.id, ["completed", "failed"]);
    expect(finishedCanary.state).toBe("completed");

    // Neither the disabled trigger nor the nextFireAt-less legacy trigger fired.
    expect(await listRuns(disabledWorkflowId)).toHaveLength(0);
    expect(await listRuns(legacyWorkflowId)).toHaveLength(0);

    const disabledAfter = await getTrigger(disabledWorkflowId, disabledTrigger.id);
    expect(disabledAfter.lastFiredAt).toBeNull();
    // Poller never touched it: nextFireAt is still the backdated past value.
    expect(disabledAfter.nextFireAt).not.toBeNull();
    expect(new Date(disabledAfter.nextFireAt!).getTime()).toBeLessThan(Date.now() - 30 * 60_000);

    const legacyAfter = await getTrigger(legacyWorkflowId, legacyRes.body.trigger.id);
    expect(legacyAfter.lastFiredAt).toBeNull();
    expect(legacyAfter.nextFireAt).toBeNull();
  }, 150_000);

  it("creates and completes a run when a webhook trigger path is posted to", async () => {
    const workflowId = await createJob("e2e webhook job", "Say {{greeting}}");
    const path = `e2e-hook-${randomUUID()}`;
    const trigger = await createTrigger(workflowId, {
      type: "webhook",
      config: { path },
    });
    // Webhook triggers are not schedule-driven: no nextFireAt.
    expect(trigger.nextFireAt).toBeNull();

    const hookRes = await api<{ runId: string }>(`/api/hooks/${path}`, {
      method: "POST",
      body: JSON.stringify({ greeting: "hello from hook" }),
    });
    expect(hookRes.status).toBe(202);
    expect(hookRes.body.runId).toBeDefined();

    const { status, body } = await api<{ run: Run }>(`/api/workflow-runs/${hookRes.body.runId}`);
    expect(status).toBe(200);
    expect(body.run.workflowId).toBe(workflowId);
    expect(body.run.triggerId).toBe(trigger.id);
    // No paramMapping → the raw webhook body passes through as run params.
    expect(body.run.params).toEqual({ greeting: "hello from hook" });

    const run = await waitForRunState(hookRes.body.runId, ["completed", "failed"]);
    expect(run.state).toBe("completed");
    expect(run.costUsd).toBe("0.0123");

    // Unknown webhook paths 404.
    const missing = await api<{ error: string }>(`/api/hooks/no-such-${randomUUID()}`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(404);
  }, 120_000);

  it("enforces the HMAC signature on webhook triggers with a secret", async () => {
    const workflowId = await createJob("e2e signed webhook job", "Signed hook run");
    const path = `e2e-signed-${randomUUID()}`;
    const secret = "e2e-webhook-secret";
    await createTrigger(workflowId, { type: "webhook", config: { path, secret } });

    // Missing signature → 401.
    const noSig = await api<{ error: string }>(`/api/hooks/${path}`, {
      method: "POST",
      body: JSON.stringify({ ping: "pong" }),
    });
    expect(noSig.status).toBe(401);

    // Wrong signature → 401.
    const badSig = await api<{ error: string }>(`/api/hooks/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-optio-signature": "deadbeef" },
      body: JSON.stringify({ ping: "pong" }),
    });
    expect(badSig.status).toBe(401);

    // Correct HMAC-SHA256 over the JSON body → 202 + run created.
    const payload = JSON.stringify({ ping: "pong" });
    const signature = createHmac("sha256", secret).update(payload).digest("hex");
    const ok = await api<{ runId: string }>(`/api/hooks/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-optio-signature": signature },
      body: payload,
    });
    expect(ok.status).toBe(202);

    const { status, body } = await api<{ run: Run }>(`/api/workflow-runs/${ok.body.runId}`);
    expect(status).toBe(200);
    expect(body.run.workflowId).toBe(workflowId);

    // No unsigned/badly-signed requests slipped through: only the signed run.
    expect(await listRuns(workflowId)).toHaveLength(1);
  }, 120_000);
});
