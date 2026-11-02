import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  modelProviders,
  optioActions,
  runCredentials,
  users,
  workspaceMembers,
} from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { credentialUseRoutes } from "../routes/credential-use.js";
import { resolvePodSecrets, resolveSecretsForTask, storeSecret } from "./secret-service.js";
import { pooledAgentEnv } from "./pooled-agent-env.js";
import { applyGitAccess } from "./git-access-env.js";
import {
  attributeRunCredentials,
  credentialFingerprint,
  withRunCredentials,
  type RunRef,
} from "./run-credentials.js";

// Values made up per test file: each must never appear in a stored row.
const tag = randomUUID().slice(0, 8);
const VALUES = {
  orgModelKey: `model-key-org-${tag}-${randomUUID()}`,
  personalModelKey: `model-key-me-${tag}-${randomUUID()}`,
  personalPodSecret: `pod-secret-me-${tag}-${randomUUID()}`,
  repoSecret: `repo-secret-${tag}-${randomUUID()}`,
  deploymentGitToken: `git-token-dep-${tag}-${randomUUID()}`,
  personalGitLabToken: `gitlab-token-me-${tag}-${randomUUID()}`,
  envGitLabToken: `gitlab-token-env-${tag}-${randomUUID()}`,
  leakedToken: `leaked-${tag}-${randomUUID()}`,
};
const GITHUB_REPO = `https://github.com/acme-${tag}/app`;
const GITLAB_HOST = `gitlab-${tag}.example.test`;
const GITLAB_REPO = `https://${GITLAB_HOST}/acme/app`;

beforeEach(() => {
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", "");
  vi.stubEnv("GITHUB_APP_ID", "");
  vi.stubEnv("GITHUB_APP_INSTALLATION_ID", "");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
  vi.stubEnv("GITLAB_HOSTS", GITLAB_HOST);
  vi.stubEnv("GITLAB_TOKEN", "");
  vi.stubEnv("OPTIO_RECORD_RUN_CREDENTIALS", "");
});
afterEach(() => vi.unstubAllEnvs());

async function insertUser(deploymentAdmin = false) {
  const [user] = await db
    .insert(users)
    .values({
      email: `${randomUUID()}@run-credentials.example.test`,
      provider: "github",
      externalId: randomUUID(),
      displayName: `Person ${tag}`,
      deploymentAdmin,
    })
    .returning();
  return user;
}

/** What the run kind's worker does: name the run, then resolve its credentials. */
async function asRun(run: RunRef, resolve: () => Promise<unknown>) {
  await withRunCredentials(async () => {
    attributeRunCredentials(run);
    await resolve();
  });
}

async function recorded(runId: string) {
  return db.select().from(runCredentials).where(eq(runCredentials.runId, runId));
}

/** Every value above, absent from every row of a table, in any column. */
async function expectNoValueIn(table: "run_credentials" | "optio_actions") {
  const rows = await db.execute<{ row: string }>(
    sql`SELECT row_to_json(t)::text AS row FROM ${sql.identifier(table)} t`,
  );
  const dump = rows.map((r) => r.row).join("\n");
  for (const value of Object.values(VALUES)) expect(dump).not.toContain(value);
}

describe("run credentials: what each kind of run is given is recorded", () => {
  it("records identities and fingerprints for tasks, Job runs, reviews, agent turns and sessions, never values", async () => {
    const ws = await insertWorkspace();
    const alice = await insertUser();
    await storeSecret("ANTHROPIC_API_KEY", VALUES.orgModelKey, "global");
    await storeSecret("ANTHROPIC_API_KEY", VALUES.personalModelKey, "user", null, alice.id);
    await storeSecret("DB_PASSWORD", VALUES.personalPodSecret, "user", null, alice.id);
    await storeSecret("DEPLOY_KEY", VALUES.repoSecret, GITHUB_REPO, ws.id);
    await storeSecret("GITHUB_TOKEN", VALUES.deploymentGitToken, "global", null);
    const gitlabName = `GITLAB_TOKEN_${GITLAB_HOST.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    await storeSecret(gitlabName, VALUES.personalGitLabToken, "user", null, alice.id);
    const [provider] = await db
      .insert(modelProviders)
      .values({
        workspaceId: ws.id,
        name: `Bedrock ${tag}`,
        agents: ["claude-code"],
        region: "us-east-1",
        podCredential: "ambient",
      })
      .returning();

    // A Repo Task: its agent key, a picked personal pod secret, git sign-in.
    const task = randomUUID();
    await asRun(
      { kind: "task", id: task, workspaceId: ws.id, userId: alice.id, repoUrl: GITHUB_REPO },
      async () => {
        await resolveSecretsForTask(["ANTHROPIC_API_KEY"], GITHUB_REPO, ws.id, null);
        await resolvePodSecrets(["DB_PASSWORD"], {
          repoUrl: GITHUB_REPO,
          workspaceId: ws.id,
          ownerUserId: alice.id,
        });
        await applyGitAccess({}, { workspaceId: ws.id, repoUrl: GITHUB_REPO, runId: task });
      },
    );
    // A Job run of the organization's: the workspace's agent key.
    const jobRun = randomUUID();
    await asRun({ kind: "job-run", id: jobRun, workspaceId: ws.id, userId: null }, () =>
      pooledAgentEnv({ agentRuntime: "claude-code", agentOptions: null }, "p", ws.id, null),
    );
    // A review: the repo's own secret.
    const review = randomUUID();
    await asRun(
      { kind: "review", id: review, workspaceId: ws.id, userId: null, repoUrl: GITHUB_REPO },
      () => resolveSecretsForTask(["DEPLOY_KEY"], GITHUB_REPO, ws.id, null),
    );
    // A personal agent's turn on GitLab: a model provider, the owner's host token.
    const turn = randomUUID();
    await asRun(
      { kind: "agent-turn", id: turn, workspaceId: ws.id, userId: alice.id, repoUrl: GITLAB_REPO },
      async () => {
        await pooledAgentEnv(
          { agentRuntime: "claude-code", agentOptions: { modelProvider: provider.id } },
          "p",
          ws.id,
          alice.id,
        );
        await applyGitAccess(
          {},
          { workspaceId: ws.id, ownerUserId: alice.id, repoUrl: GITLAB_REPO, helper: false },
        );
      },
    );
    // A session turn: the owner's own agent key, and a GitLab token from the
    // API's environment when nobody stored one.
    vi.stubEnv("GITLAB_TOKEN", VALUES.envGitLabToken);
    const session = randomUUID();
    await asRun(
      { kind: "session", id: session, workspaceId: ws.id, userId: null, repoUrl: GITLAB_REPO },
      async () => {
        await pooledAgentEnv(
          { agentRuntime: "claude-code", agentOptions: null },
          "p",
          ws.id,
          alice.id,
        );
        await applyGitAccess({}, { workspaceId: null, repoUrl: GITLAB_REPO, helper: false });
      },
    );

    const pick = (rows: Awaited<ReturnType<typeof recorded>>) =>
      rows
        .map((r) => ({ kind: r.kind, scope: r.scope, name: r.name, host: r.host }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const fp = (v: string) => credentialFingerprint(v);

    const taskRows = await recorded(task);
    expect(pick(taskRows)).toEqual([
      { kind: "model-key", scope: "deployment", name: "ANTHROPIC_API_KEY", host: null },
      { kind: "secret", scope: "personal", name: "DB_PASSWORD", host: null },
      { kind: "git-token", scope: "deployment", name: "GITHUB_TOKEN", host: "github.com" },
    ]);
    expect(taskRows.every((r) => r.runKind === "task" && r.userId === alice.id)).toBe(true);
    expect(taskRows.find((r) => r.name === "GITHUB_TOKEN")?.fingerprint).toBe(
      fp(VALUES.deploymentGitToken),
    );
    expect(taskRows.find((r) => r.name === "DB_PASSWORD")?.credentialId).toBeTruthy();

    expect(pick(await recorded(jobRun))).toEqual([
      { kind: "model-key", scope: "deployment", name: "ANTHROPIC_API_KEY", host: null },
    ]);
    expect((await recorded(jobRun))[0].fingerprint).toBe(fp(VALUES.orgModelKey));

    expect(pick(await recorded(review))).toEqual([
      { kind: "secret", scope: "repo", name: "DEPLOY_KEY", host: null },
    ]);

    const turnRows = await recorded(turn);
    // applyGitAccess also hands a GitLab pod the GitHub token (for other repos).
    expect(pick(turnRows)).toEqual([
      { kind: "model-provider", scope: "workspace", name: `Bedrock ${tag}`, host: null },
      { kind: "git-token", scope: "deployment", name: "GITHUB_TOKEN", host: null },
      { kind: "git-token", scope: "personal", name: gitlabName, host: GITLAB_HOST },
    ]);
    expect(turnRows.find((r) => r.kind === "model-provider")?.credentialId).toBe(provider.id);
    expect(turnRows.find((r) => r.kind === "git-token")?.fingerprint).toBe(
      fp(VALUES.personalGitLabToken),
    );

    expect(pick(await recorded(session))).toEqual([
      { kind: "model-key", scope: "personal", name: "ANTHROPIC_API_KEY", host: null },
      { kind: "git-token", scope: "deployment", name: "GITHUB_TOKEN", host: null },
      { kind: "git-token", scope: "environment", name: "GITLAB_TOKEN", host: GITLAB_HOST },
    ]);
    expect((await recorded(session)).map((r) => r.fingerprint).sort()).toEqual(
      [
        fp(VALUES.personalModelKey),
        fp(VALUES.deploymentGitToken),
        fp(VALUES.envGitLabToken),
      ].sort(),
    );

    await expectNoValueIn("run_credentials");
  });

  it("records nothing outside a run, for a run that never started, or when switched off", async () => {
    const ws = await insertWorkspace();
    await storeSecret("ANTHROPIC_API_KEY", VALUES.orgModelKey, "global");
    const before = (await db.select().from(runCredentials)).length;

    // Outside any run.
    await resolveSecretsForTask(["ANTHROPIC_API_KEY"], "global", ws.id);
    // Resolved, but the run was never named (it didn't start).
    await withRunCredentials(() => resolveSecretsForTask(["ANTHROPIC_API_KEY"], "global", ws.id));
    // Switched off.
    vi.stubEnv("OPTIO_RECORD_RUN_CREDENTIALS", "false");
    const off = randomUUID();
    await asRun({ kind: "task", id: off, workspaceId: ws.id, userId: null }, () =>
      resolveSecretsForTask(["ANTHROPIC_API_KEY"], "global", ws.id),
    );

    expect((await db.select().from(runCredentials)).length).toBe(before);
  });

  it("records a credential once per run however often it is read", async () => {
    const ws = await insertWorkspace();
    await storeSecret("ANTHROPIC_API_KEY", VALUES.orgModelKey, "global");
    const run = randomUUID();
    await asRun({ kind: "task", id: run, workspaceId: ws.id, userId: null }, async () => {
      for (let i = 0; i < 3; i++)
        await resolveSecretsForTask(["ANTHROPIC_API_KEY"], "global", ws.id);
    });
    expect(await recorded(run)).toHaveLength(1);
  });
});

describe("credential use search (Settings → Access)", () => {
  async function appAs(deploymentAdmin: boolean) {
    const ws = await insertWorkspace();
    const user = await insertUser(deploymentAdmin);
    await db
      .insert(workspaceMembers)
      .values({ userId: user.id, workspaceId: ws.id, role: "admin" });
    const app = await buildRouteTestApp(credentialUseRoutes, {
      user: { id: user.id, workspaceId: ws.id, workspaceRole: "admin" },
    });
    return { app, user };
  }

  it("finds the runs given a pasted value, filters by time, exports CSV, and logs the search without the value", async () => {
    // A deployment admin exists, so the founding-workspace fallback doesn't apply.
    const { app: admin, user: adminUser } = await appAs(true);
    const { app: workspaceAdmin } = await appAs(false);
    const ws = await insertWorkspace({ name: `Team ${tag}` });
    const bob = await insertUser();
    const leaked = VALUES.leakedToken;
    await storeSecret("GITHUB_TOKEN", leaked, "global");
    const runs = [randomUUID(), randomUUID()];
    for (const id of runs) {
      await asRun(
        { kind: "task", id, workspaceId: ws.id, userId: bob.id, repoUrl: GITHUB_REPO },
        () => resolveSecretsForTask(["GITHUB_TOKEN"], "global", ws.id),
      );
    }
    // Another credential's run doesn't match.
    await storeSecret("OTHER_TOKEN", VALUES.repoSecret, "global");
    const other = randomUUID();
    await asRun({ kind: "job-run", id: other, workspaceId: ws.id, userId: null }, () =>
      resolveSecretsForTask(["OTHER_TOKEN"], "global", ws.id),
    );

    const denied = await workspaceAdmin.inject({
      method: "POST",
      url: "/api/credential-use/search",
      payload: { value: leaked },
    });
    expect(denied.statusCode).toBe(403);
    const deniedExport = await workspaceAdmin.inject({
      method: "POST",
      url: "/api/credential-use/export",
      payload: { value: leaked },
    });
    expect(deniedExport.statusCode).toBe(403);

    const found = await admin.inject({
      method: "POST",
      url: "/api/credential-use/search",
      // Pasted with a trailing newline, as people do.
      payload: { value: `${leaked}\n` },
    });
    expect(found.statusCode).toBe(200);
    const body = found.json();
    expect(body.fingerprint).toBe(credentialFingerprint(leaked));
    expect(body.rows.map((r: { runId: string }) => r.runId).sort()).toEqual([...runs].sort());
    expect(body.rows[0]).toMatchObject({
      runKind: "task",
      workspaceId: ws.id,
      workspaceName: `Team ${tag}`,
      userId: bob.id,
      userName: `Person ${tag}`,
      repoUrl: GITHUB_REPO,
      kind: "git-token",
      scope: "deployment",
      name: "GITHUB_TOKEN",
      host: "github.com",
    });

    const byFingerprint = await admin.inject({
      method: "POST",
      url: "/api/credential-use/search",
      payload: { fingerprint: body.fingerprint, limit: 1 },
    });
    expect(byFingerprint.json().rows).toHaveLength(1);
    expect(byFingerprint.json().truncated).toBe(true);

    const future = await admin.inject({
      method: "POST",
      url: "/api/credential-use/search",
      payload: { value: leaked, from: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(future.json().rows).toEqual([]);

    const byName = await admin.inject({
      method: "POST",
      url: "/api/credential-use/search",
      payload: { name: "OTHER_TOKEN" },
    });
    expect(byName.json().rows.map((r: { runId: string }) => r.runId)).toEqual([other]);

    const csv = await admin.inject({
      method: "POST",
      url: "/api/credential-use/export",
      payload: { value: leaked },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toMatch(/attachment; filename="credential-use-/);
    const lines = csv.body.trim().split("\r\n");
    expect(lines[0]).toBe(
      "usedAt,runKind,runId,workspaceName,workspaceId,userName,userEmail,userId,repoUrl,kind,scope,name,credentialId,host,fingerprint",
    );
    expect(lines).toHaveLength(3);
    for (const id of runs) expect(csv.body).toContain(id);
    expect(csv.body).not.toContain(leaked);

    const logged = await db
      .select()
      .from(optioActions)
      .where(eq(optioActions.userId, adminUser.id));
    expect(logged.map((a) => a.action).sort()).toEqual(
      [
        "credential_use.export",
        "credential_use.search",
        "credential_use.search",
        "credential_use.search",
        "credential_use.search",
      ].sort(),
    );
    expect(logged.find((a) => a.action === "credential_use.export")?.result).toMatchObject({
      matched: 2,
      byValue: true,
      fingerprint: credentialFingerprint(leaked),
    });
    await expectNoValueIn("optio_actions");
    await expectNoValueIn("run_credentials");
  });

  it("asks who is calling", async () => {
    const app = await buildRouteTestApp(credentialUseRoutes, { user: null });
    const res = await app.inject({
      method: "POST",
      url: "/api/credential-use/search",
      payload: { name: "GITHUB_TOKEN" },
    });
    expect(res.statusCode).toBe(401);
  });
});
