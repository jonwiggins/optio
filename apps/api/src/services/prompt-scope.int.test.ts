/**
 * Prompts across workspaces, against real tables: the default prompts are
 * each workspace's own (falling back to the deployment's, which only a
 * deployment admin writes), the prompts with no workspace are read-only to
 * everyone else, the effective prompt reads the workspace's own repo row,
 * a saved prompt linked to work must be one its workspace and owner may use,
 * and a command template can't hand a param to a second parser.
 *
 * Two workspaces: Mallory is in A (a member, or its admin), Victor is the
 * admin of B, and Dee is the deployment admin.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type { WorkSpec } from "@optio/shared";
import { db } from "../db/client.js";
import { persistentAgents, promptTemplates, users, workspaceMembers } from "../db/schema.js";
import {
  insertLocalBlueprint,
  insertRepo,
  insertTaskConfig,
  insertWorkflow,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { promptTemplateRoutes } from "../routes/prompt-templates.js";
import { taskConfigRoutes } from "../routes/task-configs.js";
import { persistentAgentRoutes } from "../routes/persistent-agents.js";
import { workflowRoutes } from "../routes/workflows.js";
import { localRoutes } from "../routes/local.js";
import { createNamedTemplate, getPromptTemplate } from "./prompt-template-service.js";
import { seedStarterPrompts } from "./starter-prompts.js";
import { createTaskConfig, instantiateTask } from "./task-config-service.js";
import { checkBlueprint, getBlueprint, spawnFromBlueprint } from "./local-blueprint-service.js";
import { registerHost } from "./local-host-service.js";
import { createWork, updateWork, WorkError } from "./work-write-service.js";

afterAll(async () => {
  const [{ taskQueue }, { workflowRunQueue }, { reconcileQueue }, { getRedisClient }] =
    await Promise.all([
      import("../workers/task-worker.js"),
      import("../workers/workflow-worker.js"),
      import("./reconcile-queue.js"),
      import("./event-bus.js"),
    ]);
  // Some queues are first imported during teardown. Let their Redis startup
  // commands finish before closing the sockets; closing during initialization
  // can reject those commands after the tests have already passed.
  await Promise.all([
    taskQueue.waitUntilReady(),
    workflowRunQueue.waitUntilReady(),
    reconcileQueue.waitUntilReady(),
    getRedisClient().ping(),
  ]);
  await Promise.all([
    taskQueue.close(),
    workflowRunQueue.close(),
    reconcileQueue.close(),
    getRedisClient().quit(),
  ]);
});

const uniq = () => randomBytes(4).toString("hex");

type Role = "admin" | "member" | "viewer";
type TestUser = { id: string; workspaceId: string; workspaceRole: Role };

async function insertUser(name: string, extra: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: randomBytes(6).toString("hex"),
      email: `${name.toLowerCase()}-${uniq()}@example.test`,
      displayName: name,
      ...extra,
    })
    .returning();
  return row;
}

async function member(workspaceId: string, name: string, role: Role): Promise<TestUser> {
  const user = await insertUser(name);
  await db.insert(workspaceMembers).values({ workspaceId, userId: user.id, role });
  return { id: user.id, workspaceId, workspaceRole: role };
}

const app = (routes: Parameters<typeof buildRouteTestApp>[0], user: TestUser) =>
  buildRouteTestApp(routes, { user });

let dee: TestUser;

beforeAll(async () => {
  // A deployment admin exists, so no founding-workspace admin stands in for one.
  const deeWs = await insertWorkspace({ name: "deployment admin's" });
  dee = await member(deeWs.id, "Dee", "admin");
  await db.update(users).set({ deploymentAdmin: true }).where(eq(users.id, dee.id));
});

describe("prompt scope across workspaces", () => {
  let wsA: string;
  let wsB: string;
  let mallory: TestUser; // member of A
  let malloryAdmin: TestUser; // admin of A
  let victor: TestUser; // admin of B

  beforeEach(async () => {
    wsB = (await insertWorkspace({ name: "victim org" })).id;
    wsA = (await insertWorkspace({ name: "mallory's" })).id;
    mallory = await member(wsA, "Mallory", "member");
    malloryAdmin = await member(wsA, "MalloryAdmin", "admin");
    victor = await member(wsB, "Victor", "admin");
    // Every test starts from no saved default and no deployment rows of its own.
    await db.delete(promptTemplates).where(isNull(promptTemplates.workspaceId));
  });

  describe("P1: the default coding prompt is each workspace's own", () => {
    it("refuses a workspace member, and a workspace admin writes only their workspace's", async () => {
      const repoB = await insertRepo({ workspaceId: wsB });
      const before = await getPromptTemplate(repoB.repoUrl, { workspaceId: wsB });
      expect(before.id).toBe("builtin");

      const asMember = await app(promptTemplateRoutes, mallory);
      const refused = await asMember.inject({
        method: "POST",
        url: "/api/prompt-templates",
        payload: { template: "MALLORY {{TASK_FILE}}" },
      });
      expect(refused.statusCode).toBe(403);
      expect(
        await db.select().from(promptTemplates).where(eq(promptTemplates.isDefault, true)),
      ).toEqual([]);

      const asAdmin = await app(promptTemplateRoutes, malloryAdmin);
      const saved = await asAdmin.inject({
        method: "POST",
        url: "/api/prompt-templates",
        payload: { template: "MALLORY {{TASK_FILE}}" },
      });
      expect(saved.statusCode).toBe(201);
      const [row] = await db
        .select()
        .from(promptTemplates)
        .where(and(eq(promptTemplates.isDefault, true), eq(promptTemplates.workspaceId, wsA)));
      expect(row.template).toContain("MALLORY");

      // A's tasks read it; B's (the worker's call, with B's repo row) don't.
      expect((await getPromptTemplate(undefined, { workspaceId: wsA })).template).toContain(
        "MALLORY",
      );
      const forB = await getPromptTemplate(repoB.repoUrl, { workspaceId: wsB, repo: repoB });
      expect(forB.id).toBe("builtin");
      const effective = await (
        await app(promptTemplateRoutes, victor)
      ).inject({ method: "GET", url: `/api/prompt-templates/effective?repoUrl=${repoB.repoUrl}` });
      expect(effective.json().template).not.toContain("MALLORY");

      // And Victor's prompt list doesn't show A's default.
      const list = await (
        await app(promptTemplateRoutes, victor)
      ).inject({ method: "GET", url: "/api/prompt-templates" });
      expect(list.json().templates.map((t: { id: string }) => t.id)).not.toContain(row.id);
    });

    it("reads the workspace's, then the deployment's, then the built-in prompt; only a deployment admin writes the deployment's", async () => {
      const refused = await (
        await app(promptTemplateRoutes, malloryAdmin)
      ).inject({
        method: "POST",
        url: "/api/prompt-templates",
        payload: { template: "FOR EVERYONE", scope: "deployment" },
      });
      expect(refused.statusCode).toBe(403);

      const saved = await (
        await app(promptTemplateRoutes, dee)
      ).inject({
        method: "POST",
        url: "/api/prompt-templates",
        payload: { template: "DEPLOYMENT DEFAULT", scope: "deployment" },
      });
      expect(saved.statusCode).toBe(201);
      expect((await getPromptTemplate(undefined, { workspaceId: wsB })).template).toBe(
        "DEPLOYMENT DEFAULT",
      );

      await (
        await app(promptTemplateRoutes, victor)
      ).inject({ method: "POST", url: "/api/prompt-templates", payload: { template: "B's OWN" } });
      expect((await getPromptTemplate(undefined, { workspaceId: wsB })).template).toBe("B's OWN");
      expect((await getPromptTemplate(undefined, { workspaceId: wsA })).template).toBe(
        "DEPLOYMENT DEFAULT",
      );
      // One default per scope: saving again updates it.
      await (
        await app(promptTemplateRoutes, victor)
      ).inject({ method: "POST", url: "/api/prompt-templates", payload: { template: "B v2" } });
      const bRows = await db
        .select()
        .from(promptTemplates)
        .where(and(eq(promptTemplates.isDefault, true), eq(promptTemplates.workspaceId, wsB)));
      expect(bRows.map((r) => r.template)).toEqual(["B v2"]);
    });

    it("keeps repo rows in their workspace, and hides the ones saved with none", async () => {
      const url = `https://github.com/acme/shared-${uniq()}`;
      const saved = await (
        await app(promptTemplateRoutes, malloryAdmin)
      ).inject({
        method: "POST",
        url: "/api/prompt-templates",
        payload: { template: "A's repo prompt", repoUrl: url },
      });
      expect(saved.statusCode).toBe(201);
      const [aRow] = await db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.repoUrl, url));
      expect(aRow.workspaceId).toBe(wsA);

      // A legacy repo row with no workspace (some workspace's, before the fix).
      const [legacy] = await db
        .insert(promptTemplates)
        .values({ name: `repo:${url}-legacy`, template: "legacy", repoUrl: `${url}-legacy` })
        .returning();
      const asVictor = await app(promptTemplateRoutes, victor);
      const ids = (await asVictor.inject({ method: "GET", url: "/api/prompt-templates" }))
        .json()
        .templates.map((t: { id: string }) => t.id);
      expect(ids).not.toContain(aRow.id);
      expect(ids).not.toContain(legacy.id);
      const patch = await asVictor.inject({
        method: "PATCH",
        url: `/api/prompt-templates/${legacy.id}`,
        payload: { template: "x" },
      });
      expect(patch.statusCode).toBe(404);
    });
  });

  describe("P2: prompts with no workspace are read-only but to a deployment admin", () => {
    it("refuses another workspace's admin, and lets the deployment admin edit", async () => {
      await seedStarterPrompts({ restore: true });
      const [starter] = await db
        .select()
        .from(promptTemplates)
        .where(
          and(eq(promptTemplates.name, "Security review"), isNull(promptTemplates.workspaceId)),
        );
      expect(starter).toBeTruthy();

      const asMallory = await app(promptTemplateRoutes, malloryAdmin);
      const patch = await asMallory.inject({
        method: "PATCH",
        url: `/api/prompt-templates/${starter.id}`,
        payload: { template: "MALLORY WAS HERE" },
      });
      expect(patch.statusCode).toBe(403);
      const del = await asMallory.inject({
        method: "DELETE",
        url: `/api/prompt-templates/${starter.id}`,
      });
      expect(del.statusCode).toBe(403);
      const [after] = await db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.id, starter.id));
      expect(after.template).toBe(starter.template);

      // Still everyone's to read and preview.
      const preview = await asMallory.inject({
        method: "POST",
        url: `/api/prompt-templates/${starter.id}/preview`,
        payload: { params: {} },
      });
      expect(preview.statusCode).toBe(200);

      const asDee = await app(promptTemplateRoutes, dee);
      const edited = await asDee.inject({
        method: "PATCH",
        url: `/api/prompt-templates/${starter.id}`,
        payload: { description: "edited by the deployment admin" },
      });
      expect(edited.statusCode).toBe(200);
    });

    it("keeps the review default per workspace, over the deployment's", async () => {
      const [deployment] = await db
        .insert(promptTemplates)
        .values({ name: "review-default", template: "DEPLOYMENT REVIEW" })
        .returning();

      const asMallory = await app(promptTemplateRoutes, malloryAdmin);
      const saved = await asMallory.inject({
        method: "POST",
        url: "/api/prompt-templates",
        payload: { template: "MALLORY REVIEW", isReview: true },
      });
      expect(saved.statusCode).toBe(201);
      // The deployment's row is untouched; A got its own.
      const [kept] = await db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.id, deployment.id));
      expect(kept.template).toBe("DEPLOYMENT REVIEW");

      const readA = await asMallory.inject({
        method: "GET",
        url: "/api/prompt-templates/review-default",
      });
      expect(readA.json().template).toBe("MALLORY REVIEW");
      const readB = await (
        await app(promptTemplateRoutes, victor)
      ).inject({ method: "GET", url: "/api/prompt-templates/review-default" });
      expect(readB.json().template).toBe("DEPLOYMENT REVIEW");

      // A member can't set the workspace's review default.
      const memberSave = await (
        await app(promptTemplateRoutes, mallory)
      ).inject({
        method: "POST",
        url: "/api/prompt-templates",
        payload: { template: "member review", isReview: true },
      });
      expect(memberSave.statusCode).toBe(403);
    });

    it("keeps the workspace's default rows its admins' through the named-prompt routes too", async () => {
      const asAdmin = await app(promptTemplateRoutes, malloryAdmin);
      await asAdmin.inject({
        method: "POST",
        url: "/api/prompt-templates",
        payload: { template: "A's default" },
      });
      await asAdmin.inject({
        method: "POST",
        url: "/api/prompt-templates",
        payload: { template: "A's review", isReview: true },
      });
      const rows = await db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.workspaceId, wsA));
      expect(rows).toHaveLength(2);

      const asMember = await app(promptTemplateRoutes, mallory);
      for (const row of rows) {
        const patch = await asMember.inject({
          method: "PATCH",
          url: `/api/prompt-templates/${row.id}`,
          payload: { template: "member's" },
        });
        expect(patch.statusCode).toBe(403);
        const del = await asMember.inject({
          method: "DELETE",
          url: `/api/prompt-templates/${row.id}`,
        });
        expect(del.statusCode).toBe(403);
      }

      // Nor can a member make a named prompt the review default by its name.
      const named = await asMember.inject({
        method: "POST",
        url: "/api/prompt-templates/named",
        payload: { name: "review-default", template: "member's review" },
      });
      expect(named.statusCode).toBe(400);
      const other = await asMember.inject({
        method: "POST",
        url: "/api/prompt-templates/named",
        payload: { name: `checklist-${uniq()}`, template: "x" },
      });
      expect(other.statusCode).toBe(201);
      const renamed = await asMember.inject({
        method: "PATCH",
        url: `/api/prompt-templates/${other.json().template.id}`,
        payload: { name: "review-default" },
      });
      expect(renamed.statusCode).toBe(400);
      const readA = await asMember.inject({
        method: "GET",
        url: "/api/prompt-templates/review-default",
      });
      expect(readA.json().template).toBe("A's review");
    });
  });

  describe("P3: the effective prompt reads the workspace's own repo row", () => {
    it("never takes another workspace's override or follow-through for the same URL", async () => {
      const url = `https://github.com/acme/shared-${uniq()}`;
      const low = (
        await insertWorkspace({ id: "00000000-0000-4000-8000-000000000001", name: "low" })
      ).id;
      await insertRepo({
        repoUrl: url,
        workspaceId: low,
        promptTemplateOverride: "MALLORY OVERRIDE",
        autoMerge: true,
      });
      await insertRepo({ repoUrl: url, workspaceId: wsB, autoMerge: false });

      const effective = await getPromptTemplate(url, { workspaceId: wsB });
      expect(effective.template).not.toBe("MALLORY OVERRIDE");
      expect(effective.autoMerge).toBe(false);

      const res = await (
        await app(promptTemplateRoutes, victor)
      ).inject({ method: "GET", url: `/api/prompt-templates/effective?repoUrl=${url}` });
      expect(res.json()).toMatchObject({ autoMerge: false });
      expect(res.json().template).not.toBe("MALLORY OVERRIDE");
    });
  });

  describe("P4: a saved prompt linked to work is its workspace's and owner's to use", () => {
    it("refuses another workspace's prompt for a scheduled Task, on save and on render", async () => {
      const aPrompt = await createNamedTemplate({
        name: `a-${uniq()}`,
        template: "A's secret runbook",
        workspaceId: wsA,
      });
      const asVictor = await app(taskConfigRoutes, victor);
      const res = await asVictor.inject({
        method: "POST",
        url: "/api/task-configs",
        payload: {
          name: `nightly-${uniq()}`,
          title: "nightly",
          prompt: "inline",
          repoUrl: "https://github.com/acme/b",
          promptTemplateId: aPrompt.id,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/Saved prompt not found/);

      // B's own prompt is fine.
      const bPrompt = await createNamedTemplate({
        name: `b-${uniq()}`,
        template: "B's runbook",
        workspaceId: wsB,
      });
      const ok = await asVictor.inject({
        method: "POST",
        url: "/api/task-configs",
        payload: {
          name: `nightly-${uniq()}`,
          title: "nightly",
          prompt: "inline",
          repoUrl: "https://github.com/acme/b",
          promptTemplateId: bPrompt.id,
        },
      });
      expect(ok.statusCode).toBe(201);
      // ...and repointing it at A's is refused.
      const repoint = await asVictor.inject({
        method: "PATCH",
        url: `/api/task-configs/${ok.json().taskConfig.id}`,
        payload: { promptTemplateId: aPrompt.id },
      });
      expect(repoint.statusCode).toBe(400);

      // A row that already points at A's prompt is refused when it fires.
      const stored = await insertTaskConfig({ workspaceId: wsB, promptTemplateId: aPrompt.id });
      await expect(instantiateTask(stored.id)).rejects.toThrow(/isn't this work's to use/);
    });

    it("keeps a private prompt to its owner's own work", async () => {
      const alice = await member(wsB, "Alice", "member");
      const bob = await member(wsB, "Bob", "member");
      const alicePrivate = await createNamedTemplate({
        name: `alice-${uniq()}`,
        template: "Alice's own",
        workspaceId: wsB,
        ownerUserId: alice.id,
      });
      const base = {
        name: `cfg-${uniq()}`,
        title: "t",
        prompt: "p",
        repoUrl: "https://github.com/acme/b",
        workspaceId: wsB,
        promptTemplateId: alicePrivate.id,
      };
      await expect(createTaskConfig({ ...base, ownerUserId: bob.id })).rejects.toThrow(
        /Saved prompt not found/,
      );
      await expect(createTaskConfig({ ...base, ownerUserId: null })).rejects.toThrow(
        /Organization work can't use a private prompt/,
      );
      await expect(
        createTaskConfig({ ...base, name: `cfg-${uniq()}`, ownerUserId: alice.id }),
      ).resolves.toMatchObject({ promptTemplateId: alicePrivate.id });
    });

    it("refuses another workspace's prompt for a Local automation, on save and on spawn", async () => {
      const aPrompt = await createNamedTemplate({
        name: `a-${uniq()}`,
        template: "A's prompt",
        workspaceId: wsA,
      });
      const owner = { userId: victor.id, workspaceId: wsB };
      expect(
        await checkBlueprint(
          { agent: "claude-code", commandTemplate: "", promptTemplateId: aPrompt.id },
          owner,
        ),
      ).toMatch(/Saved prompt not found/);
      // A command automation never runs a saved prompt.
      const bPrompt = await createNamedTemplate({
        name: `b-${uniq()}`,
        template: "rm -rf {{x}}",
        workspaceId: wsB,
      });
      expect(
        await checkBlueprint(
          { agent: null, commandTemplate: "", promptTemplateId: bPrompt.id },
          owner,
        ),
      ).toMatch(/command automation runs its own command/);

      const host = await registerHost({
        userId: victor.id,
        workspaceId: wsB,
        hostname: `it-host-${uniq()}`,
        platform: "darwin",
        dirs: [{ path: "/home/v/app" }],
      });
      const row = await insertLocalBlueprint({
        workspaceId: wsB,
        ownerUserId: victor.id,
        agentType: "claude-code",
        commandTemplate: "",
        promptTemplateId: aPrompt.id,
        hostId: host.id,
        dir: "/home/v/app",
      });
      const blueprint = (await getBlueprint(row.id))!;
      await expect(spawnFromBlueprint(blueprint, {})).rejects.toThrow(/isn't this work's to use/);
    });

    it("refuses another workspace's prompt for a persistent agent", async () => {
      const aPrompt = await createNamedTemplate({
        name: `a-${uniq()}`,
        template: "A's prompt",
        workspaceId: wsA,
      });
      const slug = `agent-${uniq()}`;
      const res = await (
        await app(persistentAgentRoutes, victor)
      ).inject({
        method: "POST",
        url: "/api/persistent-agents",
        payload: { slug, name: slug, initialPrompt: "hi", promptTemplateId: aPrompt.id },
      });
      expect(res.statusCode).toBe(400);
      expect(
        await db.select().from(persistentAgents).where(eq(persistentAgents.slug, slug)),
      ).toEqual([]);
    });
  });

  describe("P5: a command template can't hand a param to a second parser", () => {
    const spec = (over: Partial<WorkSpec> = {}): WorkSpec => ({
      name: `cmd ${uniq()}`,
      when: { type: "schedule", config: { cronExpression: "0 3 * * *" } },
      where: { runTarget: "cluster" },
      who: { runtime: null },
      what: { prompt: "./nightly.sh {{title}}" },
      then: "exits",
      ...over,
    });

    it("refuses one through /api/work on create and on change, and keeps a stored one", async () => {
      const actor = { workspaceId: wsB, userId: null, isAdmin: false };
      const err = await createWork(
        spec({ what: { prompt: 'sh -c "echo {{title}}"' } }),
        actor,
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(WorkError);
      expect((err as WorkError).status).toBe(400);
      expect((err as WorkError).message).toMatch(/Unsafe command template: \{\{title\}\}.*`sh -c`/);

      // An agent's prompt isn't a command: the same text is fine there.
      await expect(
        createWork(
          spec({ who: { runtime: "claude-code" }, what: { prompt: 'sh -c "echo {{title}}"' } }),
          actor,
        ),
      ).resolves.toMatchObject({ kind: "standalone" });

      const made = await createWork(spec(), actor);
      await expect(
        updateWork(made.id, spec({ what: { prompt: "[[ {{title}} -eq 1 ]] && echo one" } }), actor),
      ).rejects.toThrow(/-eq/);

      // Saved before the check: an edit that leaves the command alone still saves.
      const stored = await insertWorkflow({
        workspaceId: wsB,
        agentType: null,
        promptTemplate: "eval {{title}}",
      });
      await expect(
        updateWork(
          stored.id,
          spec({ name: `renamed ${uniq()}`, what: { prompt: "eval {{title}}" } }),
          actor,
        ),
      ).resolves.toMatchObject({ id: stored.id });

      // A Local automation's command, the same.
      const automation = await createWork(
        spec({
          where: { runTarget: "local" },
          what: { prompt: "ssh deploy@host {{title}}" },
        }),
        actor,
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect((automation as WorkError).status).toBe(400);
    });

    it("refuses one through the legacy Job and Local automation routes", async () => {
      const jobs = await app(workflowRoutes, victor);
      const unsafe = await jobs.inject({
        method: "POST",
        url: "/api/jobs",
        payload: { name: `job-${uniq()}`, agentRuntime: "shell", promptTemplate: "eval {{cmd}}" },
      });
      expect(unsafe.statusCode).toBe(400);
      expect(unsafe.json().error).toMatch(/Unsafe command template/);
      const safe = await jobs.inject({
        method: "POST",
        url: "/api/jobs",
        payload: { name: `job-${uniq()}`, agentRuntime: "shell", promptTemplate: "./x.sh {{cmd}}" },
      });
      expect(safe.statusCode).toBe(201);
      const id = safe.json().workflow.id;
      const changed = await jobs.inject({
        method: "PATCH",
        url: `/api/jobs/${id}`,
        payload: { promptTemplate: "echo $(( {{n}} + 1 ))" },
      });
      expect(changed.statusCode).toBe(400);
      const renamed = await jobs.inject({
        method: "PATCH",
        url: `/api/jobs/${id}`,
        payload: { name: `job-${uniq()}` },
      });
      expect(renamed.statusCode).toBe(200);

      const local = await app(localRoutes, victor);
      const refused = await local.inject({
        method: "POST",
        url: "/api/local/blueprints",
        payload: { name: `auto-${uniq()}`, commandTemplate: 'bash -c "notify {{title}}"' },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error).toMatch(/Unsafe command template/);

      // A stored one keeps saving when its command isn't what changes.
      const stored = await insertLocalBlueprint({
        workspaceId: wsB,
        ownerUserId: victor.id,
        commandTemplate: 'bash -c "notify {{title}}"',
      });
      const paused = await local.inject({
        method: "PATCH",
        url: `/api/local/blueprints/${stored.id}`,
        payload: { enabled: false },
      });
      expect(paused.statusCode).toBe(200);
      const edited = await local.inject({
        method: "PATCH",
        url: `/api/local/blueprints/${stored.id}`,
        payload: { commandTemplate: "let n={{n}}" },
      });
      expect(edited.statusCode).toBe(400);
    });
  });
});
