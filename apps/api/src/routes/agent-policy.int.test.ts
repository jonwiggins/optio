/**
 * Agent policy against real Postgres (routes/agent-policy.ts,
 * services/agent-policy.ts): who may read and change a workspace's and a
 * repo's rules (workspace admins of that workspace only), the action log,
 * and what a run gets: nothing at all while nothing is set, Claude Code's
 * managed settings or OpenCode's inline config once something is.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  CLAUDE_MANAGED_SETTINGS_PATH,
  STANDARD_DENY_RULES,
  type AgentContainerConfig,
} from "@optio/shared";
import { db } from "../db/client.js";
import { agentPolicies, optioActions, users, workspaceMembers } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertRepo, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { applyAgentPolicy } from "../services/agent-policy.js";
import { buildAgentEnvironment } from "../services/agent-environment-service.js";
import { agentPolicyRoutes } from "./agent-policy.js";

type SetupFile = NonNullable<AgentContainerConfig["setupFiles"]>[number];
type Role = "admin" | "member" | "viewer";

let wsId: string;
let otherWsId: string;
let admin: string;
let member: string;
let repoId: string;
let repoUrl: string;
let otherRepoId: string;
const apps: FastifyInstance[] = [];

async function person(workspaceId: string, role: Role) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: randomUUID(),
      email: `${randomUUID()}@policy.example.test`,
      displayName: "Policy test",
    })
    .returning();
  await db.insert(workspaceMembers).values({ workspaceId, userId: row!.id, role });
  return row!.id;
}

async function as(userId: string, role: Role, workspaceId = wsId) {
  const app = await buildRouteTestApp(agentPolicyRoutes, {
    user: { id: userId, workspaceId, workspaceRole: role },
  });
  apps.push(app);
  return app;
}

/** What a run of `agentType` gets: its setup files and env. */
async function run(agentType: string, workspaceId: string | null = wsId, url = repoUrl) {
  const setupFiles: SetupFile[] = [];
  const env: Record<string, string> = {};
  const applied = await applyAgentPolicy({ agentType, workspaceId, repoUrl: url }, setupFiles, env);
  return { applied, setupFiles, env };
}

const managedDeny = (files: SetupFile[]) => {
  const f = files.find((x) => x.path === CLAUDE_MANAGED_SETTINGS_PATH);
  return f ? (JSON.parse(f.content) as { permissions: { deny: string[] } }).permissions.deny : null;
};

beforeAll(async () => {
  wsId = (await insertWorkspace()).id;
  otherWsId = (await insertWorkspace()).id;
  admin = await person(wsId, "admin");
  member = await person(wsId, "member");
  repoUrl = `https://github.com/policy-org/policy-${randomUUID().slice(0, 8)}`;
  repoId = (await insertRepo({ workspaceId: wsId, repoUrl })).id;
  otherRepoId = (await insertRepo({ workspaceId: otherWsId })).id;
});

beforeEach(() => {
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  vi.stubEnv("OPTIO_AGENT_POLICY_DEFAULTS", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

afterAll(async () => {
  await db.delete(agentPolicies).where(eq(agentPolicies.workspaceId, wsId));
});

describe("with nothing set (the default)", () => {
  it("adds no file and no env to any run", async () => {
    for (const agentType of ["claude-code", "opencode", "codex"]) {
      const { applied, setupFiles, env } = await run(agentType, otherWsId);
      expect(applied).toBeNull();
      expect(setupFiles).toEqual([]);
      expect(env).toEqual({});
    }
  });

  it("leaves buildAgentEnvironment's output as it was", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const env = await buildAgentEnvironment(
      { repoUrl: null, agentType: "claude-code", workspaceId: otherWsId, ownerUserId: null },
      log,
    );
    expect(env).toEqual({});
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), "Applying the agent policy");
  });
});

describe("who may read and change it", () => {
  it("lets a member read the workspace's policy but not change it", async () => {
    const app = await as(member, "member");
    const got = await app.inject({ method: "GET", url: "/api/agent-policy" });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({
      policy: null,
      canEdit: false,
      builtIn: [...STANDARD_DENY_RULES],
      deployment: { builtInRules: false, runtimeClassName: null, egress: { mode: "not-set" } },
    });
    const put = await app.inject({
      method: "PUT",
      url: "/api/agent-policy",
      payload: { denyRules: ["Bash(x)"] },
    });
    expect(put.statusCode).toBe(403);
    const putRepo = await app.inject({
      method: "PUT",
      url: `/api/repos/${repoId}/agent-policy`,
      payload: { denyRules: ["Bash(x)"] },
    });
    expect(putRepo.statusCode).toBe(403);
    expect(
      await db.select().from(agentPolicies).where(eq(agentPolicies.workspaceId, wsId)),
    ).toEqual([]);
  });

  it("never reaches another workspace's repo, even as an admin", async () => {
    const app = await as(admin, "admin");
    for (const method of ["GET", "PUT"] as const) {
      const res = await app.inject({
        method,
        url: `/api/repos/${otherRepoId}/agent-policy`,
        ...(method === "PUT" ? { payload: { denyRules: ["Bash(x)"] } } : {}),
      });
      expect(res.statusCode).toBe(404);
    }
    expect(
      await db.select().from(agentPolicies).where(eq(agentPolicies.repoId, otherRepoId)),
    ).toEqual([]);
  });

  it("refuses a malformed rule and a field the level doesn't hold", async () => {
    const app = await as(admin, "admin");
    const bad = await app.inject({
      method: "PUT",
      url: "/api/agent-policy",
      payload: { denyRules: ["Read("] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('"Read("');
    const extra = await app.inject({
      method: "PUT",
      url: `/api/repos/${repoId}/agent-policy`,
      payload: { denyRules: [], builtInRules: true },
    });
    expect(extra.statusCode).toBe(400);
  });
});

describe("once a workspace admin sets rules", () => {
  it("stores them, logs the change, and writes them into Claude Code's managed settings", async () => {
    const app = await as(admin, "admin");
    const ws = await app.inject({
      method: "PUT",
      url: "/api/agent-policy",
      payload: { denyRules: ["Read(**/secrets/**)", " Read(**/secrets/**) "] },
    });
    expect(ws.statusCode).toBe(200);
    expect(ws.json().policy).toEqual({ denyRules: ["Read(**/secrets/**)"] });
    const repo = await app.inject({
      method: "PUT",
      url: `/api/repos/${repoId}/agent-policy`,
      payload: { denyRules: ["Bash(terraform apply*)"] },
    });
    expect(repo.statusCode).toBe(200);

    const [entry] = await db
      .select()
      .from(optioActions)
      .where(
        and(eq(optioActions.workspaceId, wsId), eq(optioActions.action, "agent_policy.update")),
      )
      .orderBy(desc(optioActions.createdAt))
      .limit(1);
    expect(entry?.params).toEqual({ scope: "repo", repoId });
    expect(entry?.result).toEqual({ added: ["Bash(terraform apply*)"], removed: [] });

    const claude = await run("claude-code");
    expect(managedDeny(claude.setupFiles)).toEqual([
      "Read(**/secrets/**)",
      "Bash(terraform apply*)",
    ]);
    expect(claude.env).toEqual({});
    // Another repo of the workspace gets the workspace's rules only.
    expect(
      managedDeny((await run("claude-code", wsId, "https://github.com/x/y")).setupFiles),
    ).toEqual(["Read(**/secrets/**)"]);
  });

  it("gives OpenCode the rules it has an equivalent for, in its inline config", async () => {
    const { setupFiles, env, applied } = await run("opencode");
    expect(setupFiles).toEqual([]);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      permission: {
        read: { "secrets/*": "deny", "*/secrets/*": "deny" },
        bash: { "terraform apply*": "deny" },
      },
    });
    expect(applied).toMatchObject({ enforcedBy: "opencode-config", notEnforced: [] });
  });

  it("lets a workspace turn the built-in rules on, but not off over the deployment", async () => {
    const app = await as(admin, "admin");
    await app.inject({ method: "PUT", url: "/api/agent-policy", payload: { builtInRules: true } });
    expect(managedDeny((await run("claude-code")).setupFiles)).toEqual(
      expect.arrayContaining([...STANDARD_DENY_RULES]),
    );
    await app.inject({ method: "PUT", url: "/api/agent-policy", payload: { builtInRules: false } });
    vi.stubEnv("OPTIO_AGENT_POLICY_DEFAULTS", "true");
    const view = await app.inject({ method: "GET", url: "/api/agent-policy" });
    expect(view.json().effective).toMatchObject({ builtInRules: true, builtInFrom: "deployment" });
    expect(managedDeny((await run("claude-code")).setupFiles)).toEqual(
      expect.arrayContaining([...STANDARD_DENY_RULES]),
    );
  });

  it("writes an empty list once the rules are removed, so a shared pod loses the old ones", async () => {
    const app = await as(admin, "admin");
    await app.inject({ method: "PUT", url: "/api/agent-policy", payload: { denyRules: [] } });
    await app.inject({
      method: "PUT",
      url: `/api/repos/${repoId}/agent-policy`,
      payload: { denyRules: [] },
    });
    const claude = await run("claude-code");
    expect(managedDeny(claude.setupFiles)).toEqual([]);
    // OpenCode's config is per run: nothing to clear.
    expect((await run("opencode")).env).toEqual({});
  });
});
