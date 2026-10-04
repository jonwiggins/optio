/**
 * The config apply against a real database: every kind created from a
 * manifest, an apply that changes nothing, drift put back, a rename, a
 * replace, pruning, adoption, per-manifest errors, and detach. The source is
 * a row like the one OPTIO_CONFIG_DIR mirrors; the directory reader has its
 * own unit test.
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { ManifestInput } from "@optio/shared";
import { db } from "../../db/client.js";
import { configObjects, configSources, workDefinitions } from "../../db/schema.js";
import { insertWorkspace } from "../../test-utils/integration/fixtures.js";
import { storeSecret } from "../secret-service.js";
import { seedBuiltInProviders, listConnections, getConnection } from "../connection-service.js";
import { listMcpServers, updateMcpServer } from "../mcp-server-service.js";
import { listPromptTemplates, updateNamedTemplate } from "../prompt-template-service.js";
import { getRepoByUrl } from "../repo-service.js";
import { listInstalledSkills } from "../installed-skill-service.js";
import * as skillService from "../skill-service.js";
import * as triggerService from "../trigger-service.js";
import { listPersistentAgents } from "../persistent-agent-service.js";
import { applyManifests, detachObject, type ConfigSourceRow } from "./apply.js";
import { exportManifests } from "./export.js";
import { managedByMap } from "./managed.js";

let ws: string;
let source: ConfigSourceRow;

const REPO = "https://github.com/acme/api";

const m = (
  kind: string,
  name: string,
  spec: Record<string, unknown>,
  path = `${kind.toLowerCase()}s/${name}.yaml`,
): ManifestInput => ({
  path,
  document: { apiVersion: "optio/v1", kind, metadata: { name }, spec },
});

const baseline = (): ManifestInput[] => [
  m("Repo", "acme/api", {
    url: REPO,
    defaultBranch: "main",
    reviewEnabled: true,
    maxConcurrentTasks: 3,
  }),
  m("McpServer", "docs", {
    command: "npx",
    args: ["-y", "docs-mcp"],
    env: { DOCS_TOKEN: "${{DOCS_TOKEN}}" },
  }),
  m("Skill", "release-notes", {
    prompt: "# Release notes",
    files: { "scripts/gen.sh": "echo hi" },
  }),
  m("Skill", "market", { source: { url: "https://github.com/acme/skills", path: "market" } }),
  m("Connection", "Linear", {
    provider: "linear",
    config: { LINEAR_API_KEY: "${{LINEAR_API_KEY}}" },
    assignments: [{ repo: REPO, permission: "write" }],
  }),
  m("Prompt", "pr-description", { template: "Describe {{pr}}", kind: "prompt" }),
  m("Work", "nightly-bump", {
    when: { schedule: "0 3 * * 1-5" },
    where: { repo: REPO, branch: "main" },
    who: { runtime: "claude-code" },
    what: { prompt: "Bump dependencies" },
    then: "until-merged",
    secrets: ["GITHUB_TOKEN"],
    environment: {
      connections: { add: ["Linear"] },
      mcpServers: { add: ["docs"] },
      skills: { add: ["release-notes"] },
    },
    params: { type: "object" },
  }),
  m("Work", "hello-job", { who: { runtime: "shell" }, what: { prompt: "echo hello" } }),
  m("Work", "helper", {
    who: { runtime: "claude-code" },
    what: { prompt: "You help." },
    then: "waits-for-messages",
    agent: { podLifecycle: "on-demand" },
  }),
];

beforeAll(async () => {
  process.env.OPTIO_CONFIG_DIR = "/etc/optio-config"; // `managedByMap` only looks when the directory source is on
  const workspace = await insertWorkspace({ slug: `cfg-${Date.now().toString(36)}` });
  ws = workspace.id;
  await seedBuiltInProviders();
  // Instance-wide secrets (scope global, no workspace): pickable in every workspace.
  await storeSecret("GITHUB_TOKEN", "ghp_x", "global", null, null);
  await storeSecret("DOCS_TOKEN", "d", "global", null, null);
  await storeSecret("LINEAR_API_KEY", "l", "global", null, null);
  const [row] = await db
    .insert(configSources)
    .values({
      workspaceId: ws,
      name: "config directory",
      kind: "dir",
      path: "/etc/optio-config",
      prune: true,
    })
    .returning();
  source = row;
});

const byKey = (result: Awaited<ReturnType<typeof applyManifests>>) =>
  new Map(result.items.map((i) => [`${i.kind}/${i.name}`, i]));

async function apply(manifests: ManifestInput[], opts: { dryRun?: boolean; prune?: boolean } = {}) {
  return applyManifests({
    workspaceId: ws,
    manifests,
    dryRun: opts.dryRun ?? false,
    source,
    prune: opts.prune ?? true,
  });
}

describe("applyManifests", () => {
  it("plans a fresh directory as creates and writes nothing in a dry run", async () => {
    const plan = await apply(baseline(), { dryRun: true });
    expect(plan.dryRun).toBe(true);
    expect(plan.summary).toMatchObject({ created: 9, errors: 0 });
    expect(
      await db.select().from(configObjects).where(eq(configObjects.sourceId, source.id)),
    ).toEqual([]);
  });

  it("creates every kind, in dependency order, with names resolved to ids", async () => {
    const result = await apply(baseline());
    expect(result.summary).toMatchObject({ created: 9, errors: 0, updated: 0, pruned: 0 });

    const repo = await getRepoByUrl(REPO, ws);
    expect(repo).toMatchObject({
      reviewEnabled: true,
      maxConcurrentTasks: 3,
      defaultBranch: "main",
    });

    const [docs] = (await listMcpServers(undefined, ws)).filter((s) => s.name === "docs");
    expect(docs.env).toEqual({ DOCS_TOKEN: "${{DOCS_TOKEN}}" });

    const custom = (await skillService.listSkills(undefined, ws)).find(
      (s) => s.name === "release-notes",
    );
    expect(custom).toMatchObject({
      layout: "skill-dir",
      files: [{ relativePath: "scripts/gen.sh", content: "echo hi" }],
    });
    expect(
      (await listInstalledSkills(undefined, ws)).find((s) => s.name === "market"),
    ).toMatchObject({
      sourceUrl: "https://github.com/acme/skills",
      subpath: "market",
      ref: "main",
    });

    const linear = (await listConnections(ws)).find((c) => c.name === "Linear")!;
    const full = (await getConnection(linear.id))!;
    expect(full.assignments).toHaveLength(1);
    expect(full.assignments![0]).toMatchObject({ repoId: repo!.id, permission: "write" });

    const [bump] = await db
      .select()
      .from(workDefinitions)
      .where(and(eq(workDefinitions.workspaceId, ws), eq(workDefinitions.name, "nightly-bump")));
    expect(bump).toMatchObject({
      kind: "repo-blueprint",
      repoUrl: REPO,
      autoResume: true,
      autoMerge: true,
      podSecrets: ["GITHUB_TOKEN"],
      ownerUserId: null,
      paramsSchema: { type: "object" },
    });
    expect(bump.settings).toEqual({
      connections: { add: [linear.id] },
      mcpServers: { add: [docs.id] },
      skills: { add: [custom!.id] },
    });
    const triggers = await triggerService.listTriggers("task_config", bump.id);
    expect(triggers.map((t) => [t.type, t.config])).toEqual([
      ["schedule", { cronExpression: "0 3 * * 1-5" }],
    ]);

    const [job] = await db
      .select()
      .from(workDefinitions)
      .where(and(eq(workDefinitions.workspaceId, ws), eq(workDefinitions.name, "hello-job")));
    expect(job).toMatchObject({ kind: "standalone", agentType: null, prompt: "echo hello" });

    const agents = await listPersistentAgents(ws);
    expect(agents.find((a) => a.slug === "helper")).toMatchObject({
      podLifecycle: "on-demand",
      ownerUserId: null,
    });

    // Every row is managed by the source, under its manifest's path.
    const managed = await managedByMap("work_definitions", [bump.id, job.id]);
    expect(managed.get(bump.id)).toMatchObject({
      kind: "Work",
      path: "works/nightly-bump.yaml",
      sourceId: source.id,
    });
  });

  it("changes nothing on a second apply of the same files", async () => {
    const result = await apply(baseline());
    expect(result.summary).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 9,
      errors: 0,
      pruned: 0,
    });
  });

  it("puts back a row edited by hand and reports it as reverted", async () => {
    const prompt = (await listPromptTemplates({ workspaceId: ws })).find(
      (p) => p.name === "pr-description",
    )!;
    await updateNamedTemplate(prompt.id, { template: "Edited in the UI" });
    const docs = (await listMcpServers(undefined, ws)).find((s) => s.name === "docs")!;
    await updateMcpServer(docs.id, { command: "bunx" });

    const result = await apply(baseline());
    const items = byKey(result);
    expect(items.get("Prompt/pr-description")).toMatchObject({
      action: "update",
      reverted: true,
      changes: ["template"],
    });
    expect(items.get("McpServer/docs")).toMatchObject({
      action: "update",
      reverted: true,
      changes: ["command"],
    });
    expect(result.summary).toMatchObject({ updated: 2, reverted: 2 });
    expect(
      (await listPromptTemplates({ workspaceId: ws })).find((p) => p.id === prompt.id)!.template,
    ).toBe("Describe {{pr}}");
  });

  it("applies a changed file as an update (not a revert), including the trigger", async () => {
    const files = baseline().map((f) =>
      f.path === "works/nightly-bump.yaml"
        ? m("Work", "nightly-bump", {
            ...(f.document as { spec: Record<string, unknown> }).spec,
            when: { webhook: { path: "nightly" } },
            priority: 5,
          })
        : f,
    );
    const result = await apply(files);
    const item = byKey(result).get("Work/nightly-bump")!;
    expect(item.action).toBe("update");
    expect(item.reverted).toBeUndefined();
    expect(item.changes).toEqual(expect.arrayContaining(["priority", "when"]));
    const [bump] = await db
      .select()
      .from(workDefinitions)
      .where(and(eq(workDefinitions.workspaceId, ws), eq(workDefinitions.name, "nightly-bump")));
    expect(bump.priority).toBe(5);
    const triggers = await triggerService.listTriggers("task_config", bump.id);
    expect(triggers.map((t) => [t.type, t.config])).toEqual([["webhook", { path: "nightly" }]]);
    // Back to the baseline for the tests below.
    await apply(baseline());
  });

  it("recreates a row whose kind changed, and prunes what the files no longer declare", async () => {
    const files = baseline()
      .filter((f) => f.path !== "works/helper.yaml")
      .map((f) =>
        f.path === "works/hello-job.yaml"
          ? m("Work", "hello-job", {
              when: { schedule: "@daily" },
              where: { repo: REPO },
              who: { runtime: "claude-code" },
              what: { prompt: "now a scheduled Task" },
            })
          : f,
      );
    const result = await apply(files);
    const items = byKey(result);
    expect(items.get("Work/hello-job")).toMatchObject({ action: "replace" });
    expect(items.get("Work/helper")).toMatchObject({ action: "prune" });
    expect(result.summary).toMatchObject({ replaced: 1, pruned: 1 });
    const [job] = await db
      .select()
      .from(workDefinitions)
      .where(and(eq(workDefinitions.workspaceId, ws), eq(workDefinitions.name, "hello-job")));
    expect(job.kind).toBe("repo-blueprint");
    expect((await listPersistentAgents(ws)).find((a) => a.slug === "helper")).toBeUndefined();
    await apply(baseline());
    expect((await listPersistentAgents(ws)).find((a) => a.slug === "helper")).toBeDefined();
  });

  it("only reports orphans when pruning is off", async () => {
    const files = baseline().filter((f) => f.path !== "prompts/pr-description.yaml");
    const result = await apply(files, { prune: false });
    expect(byKey(result).get("Prompt/pr-description")).toMatchObject({
      action: "unchanged",
      message: expect.stringMatching(/pruning is off/),
    });
    expect(
      (await listPromptTemplates({ workspaceId: ws })).some((p) => p.name === "pr-description"),
    ).toBe(true);
  });

  it("fails one manifest at a time: unknown names, a credential in the clear, a one-off Task", async () => {
    const files = [
      ...baseline(),
      m("Work", "bad-env", {
        who: { runtime: "shell" },
        what: { prompt: "x" },
        environment: { connections: { add: ["Nope"] } },
      }),
      m("Work", "bad-secret", {
        who: { runtime: "shell" },
        what: { prompt: "x" },
        secrets: ["MISSING"],
      }),
      m("Work", "one-off", {
        where: { repo: REPO },
        who: { runtime: "claude-code" },
        what: { prompt: "x" },
      }),
      m("Connection", "Leaky", { provider: "linear", config: { LINEAR_API_KEY: "lin_api_123" } }),
      m("Prompt", "pr-description", { template: "dup" }, "prompts/dup.yaml"),
      { path: "junk.yaml", document: { kind: "Work", metadata: { name: "junk" }, spec: {} } },
    ];
    const result = await apply(files);
    const items = byKey(result);
    expect(items.get("Work/bad-env")).toMatchObject({
      action: "error",
      message: expect.stringMatching(/Unknown connection "Nope"/),
    });
    expect(items.get("Work/bad-secret")).toMatchObject({ action: "error" });
    expect(items.get("Work/one-off")).toMatchObject({
      action: "error",
      message: expect.stringMatching(/runs once/),
    });
    expect(items.get("Connection/Leaky")).toMatchObject({
      action: "error",
      message: expect.stringMatching(/credential/),
    });
    expect(result.items.find((i) => i.path === "prompts/dup.yaml")).toMatchObject({
      action: "error",
      message: expect.stringMatching(/more than once/),
    });
    expect(result.items.find((i) => i.path === "junk.yaml")).toMatchObject({ action: "error" });
    expect(result.summary.errors).toBe(6);
    // The good manifests still applied (nothing changed, nothing pruned).
    expect(result.summary).toMatchObject({ unchanged: 9, pruned: 0 });
  });

  it("adopts an existing unmanaged resource with the manifest's name", async () => {
    const made = await skillService.createSkill({ name: "handmade", prompt: "by hand" }, ws);
    const result = await apply([...baseline(), m("Skill", "handmade", { prompt: "by hand" })]);
    expect(byKey(result).get("Skill/handmade")).toMatchObject({
      action: "adopt",
      resourceId: made.id,
    });
    expect((await managedByMap("custom_skills", [made.id])).get(made.id)).toMatchObject({
      kind: "Skill",
    });
    // A later apply without it prunes it like any other managed row.
    const pruned = await apply(baseline());
    expect(byKey(pruned).get("Skill/handmade")).toMatchObject({ action: "prune" });
    expect(await skillService.getSkill(made.id)).toBeNull();
  });

  it("detaches: the bookkeeping goes, the row stays, the next apply adopts it again", async () => {
    const docs = (await listMcpServers(undefined, ws)).find((s) => s.name === "docs")!;
    const before = (await managedByMap("mcp_servers", [docs.id])).get(docs.id)!;
    expect(await detachObject(before.objectId, ws)).toBe(true);
    expect((await managedByMap("mcp_servers", [docs.id])).size).toBe(0);
    expect(await detachObject(before.objectId, ws)).toBe(false);
    const result = await apply(baseline());
    expect(byKey(result).get("McpServer/docs")).toMatchObject({
      action: "adopt",
      resourceId: docs.id,
    });
  });

  it("exports what it applied, with names in place of ids and no secret values", async () => {
    const exported = await exportManifests(ws);
    const names = exported.map((e) => `${e.kind}/${e.name}`);
    expect(names).toEqual(
      expect.arrayContaining([
        "Repo/acme/api",
        "McpServer/docs",
        "Skill/release-notes",
        "Skill/market",
        "Connection/Linear",
        "Prompt/pr-description",
        "Work/nightly-bump",
        "Work/hello-job",
        "Work/helper",
      ]),
    );
    const bump = exported.find((e) => e.name === "nightly-bump")!.document as {
      spec: Record<string, unknown>;
    };
    expect(bump.spec).toMatchObject({
      when: { schedule: "0 3 * * 1-5" },
      where: { repo: REPO, branch: "main" },
      who: { runtime: "claude-code" },
      then: "until-merged",
      secrets: ["GITHUB_TOKEN"],
      environment: {
        connections: { add: ["Linear"] },
        mcpServers: { add: ["docs"] },
        skills: { add: ["release-notes"] },
      },
    });
    const linear = exported.find((e) => e.name === "Linear")!.document as {
      spec: Record<string, unknown>;
    };
    expect(linear.spec).toMatchObject({
      provider: "linear",
      config: { LINEAR_API_KEY: "${{LINEAR_API_KEY}}" },
      assignments: [{ repo: REPO, permission: "write" }],
    });
    expect(exported.find((e) => e.name === "helper")!.path).toBe("work/helper.yaml");
    // Applying the export back changes nothing.
    const again = await apply(exported.map((e) => ({ path: e.path, document: e.document })));
    expect(again.summary).toMatchObject({ errors: 0, created: 0, updated: 0, pruned: 0 });
  });
});
