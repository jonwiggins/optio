/**
 * Agent policy (routes/agent-policy.ts, services/agent-policy.ts) against
 * real Postgres: who may read and change the workspace's, a team's and a
 * repo's policy (workspace admins; a team's admins for their team; never
 * across workspaces), a RuntimeClass the deployment doesn't list refused
 * when a repo picks it and when its pod is made, the audit entry for every
 * change, and what a run got — written into its setup files, recorded, and
 * shown only to people who may see the run.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { STANDARD_DENY_RULES, type AgentContainerConfig } from "@optio/shared";
import { db } from "../db/client.js";
import { optioActions, teams, users, workspaceMembers } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertRepo, insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import {
  applyAgentPolicy,
  remoteWorkspacePolicyParameters,
  repoRuntimeClass,
} from "../services/agent-policy.js";
import { buildAgentEnvironment } from "../services/agent-environment-service.js";
import { resolvePodSecrets, storeSecret } from "../services/secret-service.js";
import { agentPolicyPodLines } from "../utils/agent-policy-pod.js";
import { buildEnvExports } from "../utils/pod-env.js";
import { agentPolicyRoutes } from "./agent-policy.js";

// These tests run with teams and the built-in deny rules on (both off by default).
vi.hoisted(() => {
  process.env.OPTIO_TEAMS_ENABLED = "true";
  process.env.OPTIO_AGENT_POLICY_DEFAULTS = "true";
});

type SetupFile = NonNullable<AgentContainerConfig["setupFiles"]>[number];
const uniq = () => randomBytes(4).toString("hex");
const MANAGED = "/etc/claude-code/managed-settings.json";

let wsId: string;
let otherWsId: string;
let admin: string;
let alice: string; // member, admin of team A
let bob: string; // member of team A
let carol: string; // member, in no team
let teamA: string;
let teamElsewhere: string;
let repoId: string;
let repoUrl: string;
let otherRepoId: string;
const apps: FastifyInstance[] = [];

async function person(name: string, wsRole: "admin" | "member" | "viewer" = "member") {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: uniq(),
      email: `${name}-${uniq()}@example.test`,
      displayName: name,
    })
    .returning();
  await db.insert(workspaceMembers).values({ workspaceId: wsId, userId: row!.id, role: wsRole });
  return row!.id;
}

async function as(
  userId: string,
  opts: {
    role?: "admin" | "member" | "viewer";
    teamIds?: string[];
    adminTeamIds?: string[];
    workspaceId?: string;
    workVisibility?: "organization" | "teams";
  } = {},
) {
  const app = await buildRouteTestApp(agentPolicyRoutes, {
    user: {
      id: userId,
      workspaceId: opts.workspaceId ?? wsId,
      workspaceRole: opts.role ?? "member",
      teamIds: opts.teamIds ?? [],
      adminTeamIds: opts.adminTeamIds ?? [],
      workVisibility: opts.workVisibility ?? "teams",
    } as never,
  });
  apps.push(app);
  return app;
}

/**
 * The pod's part of the policy (utils/agent-policy-pod.ts) with a run's env
 * exported, as every exec script runs it; the OpenCode config the agent
 * would start with. The setup files are left out (they write under /home).
 */
function inPod(env: Record<string, string>, claudePath?: string): string {
  const { OPTIO_SETUP_FILES: _files, ...rest } = env;
  return execFileSync(
    "bash",
    [
      "-c",
      [
        "set -e",
        ...buildEnvExports(rest),
        ...agentPolicyPodLines(claudePath),
        `printf 'CONFIG=%s\\n' "\${OPENCODE_CONFIG_CONTENT:-}"`,
      ].join("\n"),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).match(/^CONFIG=(.*)$/m)![1]!;
}

async function lastAudit(): Promise<Record<string, unknown> | undefined> {
  const [row] = await db
    .select({ params: optioActions.params })
    .from(optioActions)
    .where(and(eq(optioActions.action, "agent_policy.update"), eq(optioActions.workspaceId, wsId)))
    .orderBy(desc(optioActions.createdAt))
    .limit(1);
  return row?.params as Record<string, unknown> | undefined;
}

beforeAll(async () => {
  wsId = (await insertWorkspace({ name: "Policy org" })).id;
  otherWsId = (await insertWorkspace({ name: "Elsewhere" })).id;
  admin = await person("admin", "admin");
  alice = await person("alice");
  bob = await person("bob");
  carol = await person("carol");
  teamA = (
    await db
      .insert(teams)
      .values({ workspaceId: wsId, name: `Team A ${uniq()}`, slug: `team-a-${uniq()}` })
      .returning()
  )[0]!.id;
  teamElsewhere = (
    await db
      .insert(teams)
      .values({ workspaceId: otherWsId, name: `Team B ${uniq()}`, slug: `team-b-${uniq()}` })
      .returning()
  )[0]!.id;
  const repo = await insertRepo({ workspaceId: wsId });
  repoId = repo!.id;
  repoUrl = repo!.repoUrl;
  otherRepoId = (await insertRepo({ workspaceId: otherWsId }))!.id;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

describe("the workspace's policy", () => {
  it("every member reads it: the built-in rules on when the deployment enables them, the egress list, the classes", async () => {
    vi.stubEnv(
      "OPTIO_AGENT_EGRESS",
      JSON.stringify({
        enforced: true,
        allow: [{ name: "GitLab", cidr: "10.0.0.5/32", ports: [443, 22] }],
      }),
    );
    vi.stubEnv("OPTIO_AGENT_RUNTIME_CLASS", "gvisor");
    const res = await (await as(carol)).inject({ method: "GET", url: "/api/agent-policy" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.canEdit).toBe(false);
    expect(body.profileDefaults).toBe(true);
    expect(body.effective.defaults).toBe(true);
    expect(body.effective.rules.map((r: { rule: string }) => r.rule)).toEqual([
      ...STANDARD_DENY_RULES,
    ]);
    expect(body.egress).toEqual({
      mode: "allowlist",
      always: ["DNS (port 53)", "The Optio API"],
      entries: [{ name: "GitLab", to: ["10.0.0.5/32"], ports: [443, 22] }],
    });
    expect(body.runtime).toEqual({ deployment: "gvisor", available: ["gvisor"] });
  });

  it("only a workspace admin changes it; the change is audited", async () => {
    const put = {
      defaults: true,
      denyRules: ["Bash(terraform apply*)", " Bash(terraform apply*) "],
    };
    const refused = await (
      await as(alice, { adminTeamIds: [teamA] })
    ).inject({
      method: "PUT",
      url: "/api/agent-policy",
      payload: put,
    });
    expect(refused.statusCode).toBe(403);

    const res = await (
      await as(admin, { role: "admin" })
    ).inject({
      method: "PUT",
      url: "/api/agent-policy",
      payload: put,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().policy).toEqual({ defaults: true, denyRules: ["Bash(terraform apply*)"] });
    await vi.waitFor(async () =>
      expect(await lastAudit()).toMatchObject({
        level: "workspace",
        added: ["Bash(terraform apply*)"],
        removed: [],
        defaults: true,
      }),
    );
  });

  it("a change sends only what changes: the rest stays", async () => {
    const res = await (
      await as(admin, { role: "admin" })
    ).inject({
      method: "PUT",
      url: "/api/agent-policy",
      payload: { defaults: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().policy).toEqual({ denyRules: ["Bash(terraform apply*)"] });
  });

  it("refuses a rule that isn't one, naming it", async () => {
    const res = await (
      await as(admin, { role: "admin" })
    ).inject({
      method: "PUT",
      url: "/api/agent-policy",
      payload: { denyRules: ["Read("] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('"Read("');
  });
});

describe("a team's rules", () => {
  it("its admins and workspace admins change them; its members and others can't", async () => {
    const payload = { denyRules: ["Bash(kubectl delete*)"] };
    const member = await (
      await as(bob, { teamIds: [teamA] })
    ).inject({
      method: "PUT",
      url: `/api/teams/${teamA}/agent-policy`,
      payload,
    });
    expect(member.statusCode).toBe(403);
    const outsider = await (
      await as(carol)
    ).inject({
      method: "PUT",
      url: `/api/teams/${teamA}/agent-policy`,
      payload,
    });
    expect(outsider.statusCode).toBe(403);
    const viewer = await (
      await as(carol, { role: "viewer", adminTeamIds: [teamA] })
    ).inject({
      method: "PUT",
      url: `/api/teams/${teamA}/agent-policy`,
      payload,
    });
    expect(viewer.statusCode).toBe(403);

    const teamAdmin = await (
      await as(alice, { teamIds: [teamA], adminTeamIds: [teamA] })
    ).inject({
      method: "PUT",
      url: `/api/teams/${teamA}/agent-policy`,
      payload,
    });
    expect(teamAdmin.statusCode).toBe(200);
    expect(teamAdmin.json().policy).toEqual({ denyRules: ["Bash(kubectl delete*)"] });
    await vi.waitFor(async () =>
      expect(await lastAudit()).toMatchObject({ level: "team", teamId: teamA }),
    );

    const wsAdmin = await (
      await as(admin, { role: "admin" })
    ).inject({
      method: "PUT",
      url: `/api/teams/${teamA}/agent-policy`,
      payload: { denyRules: ["Bash(kubectl delete*)", "Read(**/kubeconfig)"] },
    });
    expect(wsAdmin.statusCode).toBe(200);

    const read = await (
      await as(bob, { teamIds: [teamA] })
    ).inject({
      method: "GET",
      url: `/api/teams/${teamA}/agent-policy`,
    });
    expect(read.json()).toEqual({
      policy: { denyRules: ["Bash(kubectl delete*)", "Read(**/kubeconfig)"] },
      canEdit: false,
    });
  });

  it("a team of another workspace is not found, even for a workspace admin", async () => {
    const app = await as(admin, { role: "admin" });
    expect(
      (await app.inject({ method: "GET", url: `/api/teams/${teamElsewhere}/agent-policy` }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/teams/${teamElsewhere}/agent-policy`,
          payload: { denyRules: ["Bash(x)"] },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("a repo's rules and RuntimeClass", () => {
  it("only a workspace admin changes them", async () => {
    const res = await (
      await as(alice, { adminTeamIds: [teamA] })
    ).inject({
      method: "PUT",
      url: `/api/repos/${repoId}/agent-policy`,
      payload: { denyRules: ["Read(**/prod.tfvars)"] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a RuntimeClass the deployment doesn't list, at once and at the pod", async () => {
    const app = await as(admin, { role: "admin" });
    const refused = await app.inject({
      method: "PUT",
      url: `/api/repos/${repoId}/agent-policy`,
      payload: { runtimeClassName: "gvisor" },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toContain('RuntimeClass "gvisor" is not available');

    vi.stubEnv("OPTIO_AGENT_RUNTIME_CLASSES", "gvisor,kata");
    const ok = await app.inject({
      method: "PUT",
      url: `/api/repos/${repoId}/agent-policy`,
      payload: { denyRules: ["Read(**/prod.tfvars)"], runtimeClassName: "kata" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().policy).toEqual({
      denyRules: ["Read(**/prod.tfvars)"],
      runtimeClassName: "kata",
    });
    expect(ok.json().runtime.available).toEqual(["gvisor", "kata"]);
    await vi.waitFor(async () =>
      expect(await lastAudit()).toMatchObject({
        level: "repo",
        repoId,
        added: ["Read(**/prod.tfvars)"],
        runtimeClassName: "kata",
      }),
    );
    expect(await repoRuntimeClass(repoUrl, wsId)).toEqual({ runtimeClassName: "kata" });

    // The cluster lost the class: the repo's next pod fails, naming the ones there are.
    vi.stubEnv("OPTIO_AGENT_RUNTIME_CLASSES", "gvisor");
    await expect(repoRuntimeClass(repoUrl, wsId)).rejects.toThrow(
      'RuntimeClass "kata" is not available in this deployment (available: gvisor)',
    );
  });

  it("a repo of another workspace is not found", async () => {
    const res = await (
      await as(admin, { role: "admin" })
    ).inject({
      method: "PUT",
      url: `/api/repos/${otherRepoId}/agent-policy`,
      payload: { denyRules: ["Bash(x)"] },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("what a run gets", () => {
  it("Claude Code: the managed settings file with every level's rules, recorded for the run", async () => {
    vi.stubEnv("OPTIO_AGENT_RUNTIME_CLASSES", "gvisor,kata");
    const task = await insertTask({
      workspaceId: wsId,
      repoUrl,
      ownerUserId: alice,
      ownerTeamId: teamA,
      createdBy: alice,
    });
    const files: SetupFile[] = [];
    const env: Record<string, string> = {};
    const run = await applyAgentPolicy(
      { repoUrl, agentType: "claude-code", workspaceId: wsId, runId: task!.id },
      files,
      env,
    );
    const managed = files.find((f) => f.path === MANAGED);
    expect(managed).toBeDefined();
    const deny: string[] = JSON.parse(managed!.content).permissions.deny;
    expect(deny).toEqual(expect.arrayContaining(["Read(**/.env*)", "Bash(git push --force *)"]));
    // The workspace's, the team's (read from the run's row) and the repo's.
    expect(deny).toEqual(
      expect.arrayContaining([
        "Bash(terraform apply*)",
        "Bash(kubectl delete*)",
        "Read(**/prod.tfvars)",
      ]),
    );
    expect(run).toMatchObject({
      enforcedBy: "claude-managed-settings",
      runtimeClassName: "kata",
      runtimeClassFrom: "repo",
    });

    // The run's page: its owner and admins see it; another member doesn't.
    const mine = await (
      await as(alice, { teamIds: [teamA] })
    ).inject({
      method: "GET",
      url: `/api/runs/${task!.id}/agent-policy`,
    });
    expect(mine.statusCode).toBe(200);
    const shown = mine.json().policy;
    expect(shown.enforcedBy).toBe("claude-managed-settings");
    expect(shown.rules).toEqual(
      expect.arrayContaining([
        { rule: "Bash(kubectl delete*)", from: "team", opencode: true },
        { rule: "Read(**/.env*)", from: "default", opencode: true },
      ]),
    );
    expect(
      (
        await (
          await as(admin, { role: "admin" })
        ).inject({
          method: "GET",
          url: `/api/runs/${task!.id}/agent-policy`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await (await as(carol)).inject({ method: "GET", url: `/api/runs/${task!.id}/agent-policy` }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await (
          await as(admin, { role: "admin", workspaceId: otherWsId })
        ).inject({
          method: "GET",
          url: `/api/runs/${task!.id}/agent-policy`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("every pod run gets it through buildAgentEnvironment, written last", async () => {
    const log = { info: () => {}, warn: () => {} } as never;
    const env = await buildAgentEnvironment(
      {
        repoUrl,
        agentType: "claude-code",
        workspaceId: wsId,
        ownerUserId: alice,
        ownerTeamId: null,
      },
      log,
      [{ path: "/home/agent/.claude/settings.json", content: "{}" }],
    );
    const files: SetupFile[] = JSON.parse(
      Buffer.from(env.OPTIO_SETUP_FILES, "base64").toString("utf8"),
    );
    expect(files[0].path).toBe("/home/agent/.claude/settings.json");
    expect(files.at(-1)!.path).toBe(MANAGED);
    const deny: string[] = JSON.parse(files.at(-1)!.content).permissions.deny;
    // No team: the workspace's and the repo's rules, not team A's.
    expect(deny).toContain("Read(**/prod.tfvars)");
    expect(deny).not.toContain("Bash(kubectl delete*)");
  });

  it("OpenCode: the same rules over its headless block, in its inline config", async () => {
    const files: SetupFile[] = [];
    const env: Record<string, string> = {};
    const run = await applyAgentPolicy(
      { repoUrl, agentType: "opencode", workspaceId: wsId, ownerTeamId: teamA },
      files,
      env,
    );
    expect(files).toEqual([]);
    const permission = JSON.parse(inPod(env)).permission;
    expect(permission["*"]).toBe("allow");
    expect(permission.question).toBe("deny");
    expect(permission.bash).toMatchObject({ "sudo *": "deny", "kubectl delete*": "deny" });
    expect(permission.read).toMatchObject({ "*.pem": "deny", ".env*": "deny" });
    expect(run?.enforcedBy).toBe("opencode-config");
  });

  it("OpenCode with its own OPENCODE_CONFIG_CONTENT pod secret: its provider stays, the rules are added", async () => {
    // A model inside the network: the provider is only in the secret.
    const own = {
      provider: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://llm.example.test/v1" },
          models: { "qwen-coder": {} },
        },
      },
      model: "local/qwen-coder",
    };
    // Team A's secret, picked by team A's work.
    await storeSecret("OPENCODE_CONFIG_CONTENT", JSON.stringify(own), "team", wsId, null, teamA);
    const picked = await resolvePodSecrets(["OPENCODE_CONFIG_CONTENT"], {
      workspaceId: wsId,
      ownerUserId: alice,
      ownerTeamId: teamA,
    });
    expect(picked.missing).toEqual([]);
    const log = { info: () => {}, warn: () => {} } as never;
    // The order every worker uses: the picked secrets first, then the agent's environment.
    const env: Record<string, string> = {
      ...picked.env,
      ...(await buildAgentEnvironment(
        {
          repoUrl,
          agentType: "opencode",
          workspaceId: wsId,
          ownerUserId: alice,
          ownerTeamId: teamA,
        },
        log,
      )),
    };
    expect(env.OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify(own));

    const got = JSON.parse(inPod(env));
    expect(got.provider).toEqual(own.provider);
    expect(got.model).toBe("local/qwen-coder");
    expect(got.permission.question).toBe("deny");
    expect(got.permission.read).toMatchObject({ ".env*": "deny", "*.pem": "deny" });
    expect(got.permission.bash).toMatchObject({ "sudo *": "deny", "kubectl delete*": "deny" });
  });

  it("Claude Code with no rules: the pod removes the file an earlier run left there", async () => {
    vi.stubEnv("OPTIO_AGENT_POLICY_DEFAULTS", "false");
    const none = (await insertWorkspace({ name: "No rules" })).id;
    const log = { info: () => {}, warn: () => {} } as never;
    const dir = join(mkdtempSync(join(tmpdir(), "optio-policy-")), "claude-code");
    mkdirSync(dir);
    const file = join(dir, "managed-settings.json");

    // A run with rules writes the file (its last setup file) and keeps it.
    const withRules = await buildAgentEnvironment(
      {
        repoUrl,
        agentType: "claude-code",
        workspaceId: wsId,
        ownerUserId: alice,
        ownerTeamId: null,
      },
      log,
    );
    const written: SetupFile[] = JSON.parse(
      Buffer.from(withRules.OPTIO_SETUP_FILES, "base64").toString("utf8"),
    );
    expect(written.at(-1)!.path).toBe(MANAGED);
    expect(written.at(-2)!.path).toBe(`${MANAGED}.optio`);
    writeFileSync(file, written.at(-1)!.content);
    writeFileSync(`${file}.optio`, written.at(-2)!.content);
    inPod(withRules, file);
    expect(existsSync(file)).toBe(true);

    // The next run in that pod has none (the workspace turned them off): the file goes.
    const noRules = await buildAgentEnvironment(
      {
        repoUrl: null,
        agentType: "claude-code",
        workspaceId: none,
        ownerUserId: alice,
        ownerTeamId: null,
      },
      log,
    );
    const noFiles: SetupFile[] = noRules.OPTIO_SETUP_FILES
      ? JSON.parse(Buffer.from(noRules.OPTIO_SETUP_FILES, "base64").toString("utf8"))
      : [];
    expect(noFiles.map((f) => f.path)).not.toContain(MANAGED);
    expect(noRules.OPTIO_CLAUDE_POLICY_CLEAR).toBe("1");
    inPod(noRules, file);
    expect(existsSync(file)).toBe(false);
  });

  it("with the built-in rules off and nothing set, nothing is written: upstream's behaviour", async () => {
    vi.stubEnv("OPTIO_AGENT_POLICY_DEFAULTS", "false");
    const ws = (await insertWorkspace({ name: "Full" })).id;
    const task = await insertTask({ workspaceId: ws });
    const files: SetupFile[] = [];
    const env: Record<string, string> = {};
    const run = await applyAgentPolicy(
      { repoUrl: task!.repoUrl, agentType: "claude-code", workspaceId: ws, runId: task!.id },
      files,
      env,
    );
    expect(files).toEqual([]);
    // Only the note to remove an earlier run's file, which does nothing where there is none.
    expect(env).toEqual({ OPTIO_CLAUDE_POLICY_CLEAR: "1" });
    expect(run).toMatchObject({ defaults: false, rules: [], enforcedBy: null });
  });

  it("skips commands and the Ask Optio assistant", async () => {
    const files: SetupFile[] = [];
    expect(
      await applyAgentPolicy({ repoUrl: null, agentType: null, workspaceId: wsId }, files, {}),
    ).toBeNull();
    expect(
      await applyAgentPolicy(
        { repoUrl: null, agentType: "claude-code", workspaceId: wsId, controllerOnly: true },
        files,
        {},
      ),
    ).toBeNull();
    expect(files).toEqual([]);
  });

  it("a remote workspace gets the policy as its parameters", async () => {
    const params = await remoteWorkspacePolicyParameters({
      workspaceId: wsId,
      ownerTeamId: teamA,
      repoUrl,
    });
    const claude = JSON.parse(params.optio_claude_managed_settings);
    expect(claude.permissions.deny).toEqual(expect.arrayContaining(["Bash(kubectl delete*)"]));
    const opencode = JSON.parse(params.optio_opencode_managed_config);
    expect(opencode.permission.bash["kubectl delete*"]).toBe("deny");

    // No rules (built-in rules off, nothing set): both blank, so a rebuilt workspace loses old ones.
    vi.stubEnv("OPTIO_AGENT_POLICY_DEFAULTS", "false");
    const ws = (await insertWorkspace({ name: "Full Coder" })).id;
    expect(await remoteWorkspacePolicyParameters({ workspaceId: ws })).toEqual({
      optio_claude_managed_settings: "",
      optio_opencode_managed_config: "",
    });
  });
});
