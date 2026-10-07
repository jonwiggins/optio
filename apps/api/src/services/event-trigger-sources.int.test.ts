/**
 * Integration test — the event sources added after GitHub / Slack / Linear
 * / Pylon / PagerDuty, through the real trigger table and dispatcher:
 * GitLab's and Jira's fan-out (`fireEventTriggers`), the per-trigger
 * Alertmanager and Datadog firings (`firingFor` + `fireTrigger`, the way
 * their receivers run them), and the secrets minted for the self-secret
 * types on create.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks, workflowRuns, workflowTriggers } from "../db/schema.js";
import * as triggerService from "./trigger-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { workflowRunQueue } from "../workers/workflow-worker.js";
import { reconcileQueue } from "./reconcile-queue.js";
import { getRedisClient } from "./event-bus.js";
import { insertTaskConfig, insertWorkflow } from "../test-utils/integration/fixtures.js";

afterAll(async () => {
  await Promise.allSettled([
    taskQueue.close(),
    workflowRunQueue.close(),
    reconcileQueue.close(),
    getRedisClient().quit(),
  ]);
});

const cleanRuns = async (fired: { kind: string; id: string }[]) => {
  for (const f of fired) {
    if (f.kind === "workflow_run") await db.delete(workflowRuns).where(eq(workflowRuns.id, f.id));
  }
};

describe("GitLab event triggers (fireEventTriggers)", () => {
  const PROJECT = (path: string) => ({
    path_with_namespace: path,
    web_url: `https://gitlab.com/${path}`,
  });
  const pipeline = (path: string, status = "failed") => ({
    object_kind: "pipeline",
    user: { username: "alice" },
    project: PROJECT(path),
    object_attributes: { id: 501, ref: "main", sha: "abc123", status, tag: false },
    commit: { title: "fix: checkout", message: "fix: checkout" },
  });

  it("a failed pipeline starts a Job run with the pipeline's fields as params", async () => {
    const { fireEventTriggers, normalizeGitLabEvent } = await import("./event-trigger-service.js");
    const stamp = Date.now().toString(36);
    const project = `acme/widgets-${stamp}`;
    const job = await insertWorkflow({
      promptTemplate: "Pipeline {{pipelineStatus}} on {{sourceBranch}}: {{url}}",
      runTitle: "{{project}}: {{title}}",
    });
    const trigger = await triggerService.createTrigger({
      targetType: "job",
      targetId: job.id,
      type: "gitlab",
      config: { events: ["pipeline_failed"], projects: [project], branches: ["main"] },
    });

    const other = await fireEventTriggers(
      "gitlab",
      normalizeGitLabEvent(pipeline(`acme/other-${stamp}`))!,
    );
    expect(other.map((f) => f.triggerId)).not.toContain(trigger.id);
    const passed = await fireEventTriggers(
      "gitlab",
      normalizeGitLabEvent(pipeline(project, "success"))!,
    );
    expect(passed.map((f) => f.triggerId)).not.toContain(trigger.id);
    await cleanRuns([...other, ...passed]);

    const hit = await fireEventTriggers("gitlab", normalizeGitLabEvent(pipeline(project))!);
    const mine = hit.filter((f) => f.triggerId === trigger.id);
    expect(mine).toEqual([
      {
        triggerId: trigger.id,
        matched: "pipeline_failed",
        kind: "workflow_run",
        id: expect.any(String),
      },
    ]);
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, mine[0].id));
    expect(run.workflowId).toBe(job.id);
    expect(run.title).toBe(`${project}: Pipeline failed on main: fix: checkout`);
    expect(run.params).toMatchObject({
      source: "gitlab",
      event: "pipeline_failed",
      kind: "pipeline",
      project,
      sourceBranch: "main",
      sha: "abc123",
      pipelineStatus: "failed",
      url: `https://gitlab.com/${project}/-/pipelines/501`,
    });
    const [after] = await db
      .select()
      .from(workflowTriggers)
      .where(eq(workflowTriggers.id, trigger.id));
    expect(after.lastFiredAt).not.toBeNull();
    await cleanRuns(hit);
  });

  it("a scheduled Task listens to its own GitLab repo by default and spawns a task on an MR", async () => {
    const { fireEventTriggers, normalizeGitLabEvent } = await import("./event-trigger-service.js");
    const stamp = Date.now().toString(36);
    const project = `acme/api-${stamp}`;
    const repoUrl = `https://gitlab.com/${project}.git`;
    const config = await insertTaskConfig({
      repoUrl,
      prompt: "Review MR !{{iid}}: {{url}}",
      title: "Review !{{iid}} {{title}}",
    });
    const trigger = await triggerService.createTrigger({
      targetType: "task_config",
      targetId: config.id,
      type: "gitlab",
      config: { events: ["mr_opened"] },
    });
    const mr = (path: string) =>
      normalizeGitLabEvent({
        object_kind: "merge_request",
        user: { username: "alice" },
        project: PROJECT(path),
        object_attributes: {
          iid: 12,
          title: "feat: widgets",
          description: "",
          action: "open",
          url: `https://gitlab.com/${path}/-/merge_requests/12`,
          source_branch: "feat/widgets",
          target_branch: "main",
        },
      })!;

    const elsewhere = await fireEventTriggers("gitlab", mr(`acme/elsewhere-${stamp}`));
    expect(elsewhere.map((f) => f.triggerId)).not.toContain(trigger.id);
    const hit = await fireEventTriggers("gitlab", mr(project));
    const mine = hit.filter((f) => f.triggerId === trigger.id);
    expect(mine).toEqual([
      { triggerId: trigger.id, matched: "mr_opened", kind: "task", id: expect.any(String) },
    ]);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, mine[0].id));
    // The spawned task carries the normalized URL (no `.git`).
    expect(task.repoUrl).toBe(`https://gitlab.com/${project}`);
    expect(task.title).toBe("Review !12 feat: widgets");
    expect(task.prompt).toBe(`Review MR !12: https://gitlab.com/${project}/-/merge_requests/12`);
    // An MR *event* the task reacts to isn't a ticket it would close on completion.
    expect(task.ticketExternalId).toBeNull();
    await cleanRuns([...elsewhere, ...hit]);
  });
});

describe("Jira event triggers (fireEventTriggers)", () => {
  it("an assignment wakes a Job run with the issue's fields and ticket aliases", async () => {
    const { fireEventTriggers, normalizeJiraEvent } = await import("./event-trigger-service.js");
    const stamp = Date.now().toString(36);
    const projectKey = `IT${stamp.slice(-4).toUpperCase()}`;
    const job = await insertWorkflow({
      promptTemplate: "Triage {{ticketExternalId}}: {{ticketUrl}}",
      runTitle: "{{key}} {{ticketTitle}}",
    });
    const trigger = await triggerService.createTrigger({
      targetType: "job",
      targetId: job.id,
      type: "jira",
      config: { events: ["assigned"], user: "Jon Wiggins", projects: [projectKey] },
    });
    const event = (assignee: string) =>
      normalizeJiraEvent({
        webhookEvent: "jira:issue_updated",
        issue_event_type_name: "issue_assigned",
        user: { accountId: "a1", displayName: "Alice" },
        issue: {
          id: "20001",
          key: `${projectKey}-7`,
          self: "https://acme.atlassian.net/rest/api/2/issue/20001",
          fields: {
            summary: "Login broken",
            project: { key: projectKey, name: "Integration" },
            status: { name: "To Do" },
            assignee: { accountId: "5b10", displayName: assignee },
            labels: ["bug"],
          },
        },
        changelog: { items: [{ field: "assignee", to: "5b10", toString: assignee }] },
      })!;

    const miss = await fireEventTriggers("jira", event("Bob"));
    expect(miss.map((f) => f.triggerId)).not.toContain(trigger.id);
    const hit = await fireEventTriggers("jira", event("Jon Wiggins"));
    const mine = hit.filter((f) => f.triggerId === trigger.id);
    expect(mine).toEqual([
      { triggerId: trigger.id, matched: "assigned", kind: "workflow_run", id: expect.any(String) },
    ]);
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, mine[0].id));
    expect(run.title).toBe(`${projectKey}-7 Login broken`);
    expect(run.params).toMatchObject({
      source: "jira",
      event: "assigned",
      key: `${projectKey}-7`,
      project: projectKey,
      assignee: "Jon Wiggins",
      ticketSource: "jira",
      ticketExternalId: `${projectKey}-7`,
      ticketUrl: `https://acme.atlassian.net/browse/${projectKey}-7`,
      ticketLabels: "bug",
    });
    await cleanRuns([...miss, ...hit]);
  });
});

describe("self-secret triggers (Alertmanager, Datadog)", () => {
  it("createTrigger mints a secret for each, kept on the row and hidden from reads", async () => {
    const job = await insertWorkflow({ promptTemplate: "p" });
    for (const type of ["alertmanager", "datadog"] as const) {
      const row = await triggerService.createTrigger({
        targetType: "job",
        targetId: job.id,
        type,
        config: { events: type === "alertmanager" ? ["firing"] : ["triggered"] },
      });
      const config = row.config as Record<string, unknown>;
      expect(config.secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(triggerService.publicTrigger(row).config).toEqual({
        events: config.events,
        hasSecret: true,
      });
    }
  });

  it("an Alertmanager group wakes a persistent agent as Alertmanager, with every alert", async () => {
    const { firingFor, normalizeAlertmanagerEvent } = await import("./event-trigger-service.js");
    const { fireTrigger } = await import("./trigger-dispatch.js");
    const { createPersistentAgent } = await import("./persistent-agent-service.js");
    const { persistentAgentMessages } = await import("../db/schema.js");
    const agent = await createPersistentAgent({
      slug: `it-am-agent-${Date.now().toString(36)}`,
      name: "On-call agent",
      initialPrompt: "You watch alerts.",
    });
    const trigger = await triggerService.createTrigger({
      targetType: "persistent_agent",
      targetId: agent.id,
      type: "alertmanager",
      config: { events: ["firing"], severities: ["critical"] },
    });
    const config = trigger.config as Record<string, unknown>;
    const group = normalizeAlertmanagerEvent({
      version: "4",
      status: "firing",
      receiver: "optio",
      groupKey: '{}:{alertname="HighLatency"}',
      externalURL: "https://am.acme.test",
      commonLabels: { alertname: "HighLatency", severity: "critical" },
      alerts: [
        {
          status: "firing",
          labels: { alertname: "HighLatency", severity: "critical", instance: "web-1" },
          annotations: { summary: "p99 over 2s" },
          fingerprint: "f1",
        },
      ],
    })!;
    expect(firingFor("alertmanager", group, { ...config, severities: ["warning"] })).toBeNull();
    const { matched, ...firing } = firingFor("alertmanager", group, config)!;
    expect(matched).toBe("firing");
    expect(await fireTrigger(trigger, firing)).toEqual({ kind: "persistent_agent", id: agent.id });

    const messages = await db
      .select()
      .from(persistentAgentMessages)
      .where(eq(persistentAgentMessages.agentId, agent.id));
    const msg = messages.find((m) => m.body.includes("HighLatency"));
    expect(msg).toBeTruthy();
    expect(msg!.senderType).toBe("system");
    expect(msg!.senderName).toBe("[FIRING] HighLatency");
    expect(msg!.body).toContain("instance=web-1");
    expect(msg!.structuredPayload).toMatchObject({
      source: "alertmanager",
      event: "firing",
      alertnames: "HighLatency",
      severities: "critical",
      count: "1",
    });
  });

  it("a Datadog monitor starts a Job run, filtered by priority", async () => {
    const { firingFor, normalizeDatadogEvent } = await import("./event-trigger-service.js");
    const { fireTrigger } = await import("./trigger-dispatch.js");
    const job = await insertWorkflow({
      promptTemplate: "{{title}} ({{priority}}): {{link}}\n{{body}}",
      runTitle: "Datadog: {{title}}",
    });
    const trigger = await triggerService.createTrigger({
      targetType: "job",
      targetId: job.id,
      type: "datadog",
      config: { events: ["triggered"], priorities: ["P1"] },
    });
    const config = trigger.config as Record<string, unknown>;
    const monitor = (priority: string) =>
      normalizeDatadogEvent({
        id: "9",
        title: "[Triggered] CPU high on web-1",
        body: "CPU over 90%",
        alert_id: "555",
        alert_transition: "Triggered",
        alert_type: "error",
        priority,
        tags: "env:prod",
        link: "https://app.datadoghq.com/event/event?id=9",
      });
    expect(firingFor("datadog", monitor("P3"), config)).toBeNull();
    const { matched, ...firing } = firingFor("datadog", monitor("P1"), config)!;
    expect(matched).toBe("triggered");
    const fired = await fireTrigger(trigger, firing);
    expect(fired).toEqual({ kind: "workflow_run", id: expect.any(String) });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, fired!.id));
    expect(run.title).toBe("Datadog: [Triggered] CPU high on web-1");
    expect(run.params).toMatchObject({
      source: "datadog",
      event: "triggered",
      alertId: "555",
      priority: "P1",
      tags: "env:prod",
    });
    await cleanRuns([fired!]);
  });
});
