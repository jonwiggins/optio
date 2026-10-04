/**
 * The agent environment against real Postgres: the repo's and the
 * workspace's MCP servers, connections, and skills are the defaults, and a
 * piece of work's settings add to them or take from them — for work with a
 * repo and work without one (a Job, a persistent agent) alike.
 */
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { buildAgentEnvironment, environmentOptions } from "./agent-environment-service.js";
import { logger } from "../logger.js";
import { createConnection, seedBuiltInProviders } from "./connection-service.js";
import { createMcpServer } from "./mcp-server-service.js";
import { createSkill } from "./skill-service.js";

const uniq = () => randomBytes(4).toString("hex");

beforeAll(async () => {
  await seedBuiltInProviders();
});

async function world() {
  const ws = await insertWorkspace();
  const [owner] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${uniq()}`,
      email: `${uniq()}@env.it`,
      displayName: "Owner",
    })
    .returning();
  const repoUrl = `https://github.com/acme/env-${uniq()}`;
  const otherRepo = `https://github.com/acme/other-${uniq()}`;
  const global = await createMcpServer({ name: "docs", command: "docs-mcp" }, ws.id);
  const ofRepo = await createMcpServer({ name: "db", command: "db-mcp", repoUrl }, ws.id);
  const ofOther = await createMcpServer(
    { name: "metrics", command: "metrics-mcp", repoUrl: otherRepo, installCommand: "npm i -g m" },
    ws.id,
  );
  const skill = await createSkill({ name: "release", prompt: "How we release" }, ws.id);
  const otherSkill = await createSkill(
    { name: "triage", prompt: "How we triage", repoUrl: otherRepo },
    ws.id,
  );
  // A connection every repo gets, one nothing assigns, and someone's own.
  const assigned = await createConnection(
    {
      name: "files",
      providerSlug: "filesystem",
      config: { ROOT_PATH: "/data" },
      assignments: [{ repoId: null }],
    },
    ws.id,
  );
  const unassigned = await createConnection(
    { name: "sentry", providerSlug: "sentry", config: { SENTRY_ORG: "acme" } },
    ws.id,
  );
  const personal = await createConnection(
    {
      name: "mine",
      providerSlug: "filesystem",
      config: { ROOT_PATH: "/home/me" },
      ownerUserId: owner.id,
    },
    ws.id,
  );
  return {
    ws,
    owner,
    repoUrl,
    global,
    ofRepo,
    ofOther,
    skill,
    otherSkill,
    assigned,
    unassigned,
    personal,
  };
}

type Env = Record<string, string>;
/** The setup files a pod would write, decoded from `OPTIO_SETUP_FILES`. */
const filesOf = (env: Env): { path: string; content: string }[] =>
  env.OPTIO_SETUP_FILES
    ? JSON.parse(Buffer.from(env.OPTIO_SETUP_FILES, "base64").toString("utf8"))
    : [];
const mcpOf = (env: Env) => {
  const file = filesOf(env).find((f) => f.path === ".mcp.json");
  return file ? (JSON.parse(file.content).mcpServers as Record<string, { command: string }>) : {};
};
const skillPaths = (env: Env) =>
  filesOf(env)
    .filter((f) => f.path.startsWith(".claude/"))
    .map((f) => f.path);
const build = (input: Parameters<typeof buildAgentEnvironment>[0]) =>
  buildAgentEnvironment(input, logger);

describe("buildAgentEnvironment", () => {
  it("gives repo work the global and repo defaults, and work with no repo the global ones", async () => {
    const w = await world();
    const base = { agentType: "claude-code", workspaceId: w.ws.id, ownerUserId: null };

    const repoEnv = await build({ ...base, repoUrl: w.repoUrl });
    const mcp = mcpOf(repoEnv);
    expect(Object.keys(mcp).sort()).toEqual(["db", "docs", "files"]);
    // A connection is served as its provider's MCP server, args filled from its config.
    expect(mcp.files).toMatchObject({ command: "npx" });
    expect(JSON.stringify(mcp.files)).toContain("/data");
    expect(skillPaths(repoEnv)).toEqual([".claude/commands/release.md"]);
    expect(repoEnv.OPTIO_WORK_SETUP_COMMANDS).toBeUndefined();

    const jobEnv = await build({ ...base, repoUrl: null });
    expect(Object.keys(mcpOf(jobEnv)).sort()).toEqual(["docs", "files"]);
  });

  it("gives a Codex run the same servers as TOML in a CODEX_HOME of its own", async () => {
    const w = await world();
    const env = await build({
      agentType: "codex",
      repoUrl: w.repoUrl,
      workspaceId: w.ws.id,
      ownerUserId: null,
    });
    expect(Object.keys(mcpOf(env)).sort()).toEqual(["db", "docs", "files"]);
    const files = filesOf(env) as { path: string; content: string; sensitive?: boolean }[];
    const toml = files.find((f) => f.path.endsWith("/config.toml"));
    expect(toml).toBeDefined();
    expect(toml!.sensitive).toBe(true);
    expect(toml!.path).toMatch(/^\/opt\/optio\/codex\/[0-9a-f]+\/config\.toml$/);
    expect(env.OPTIO_CODEX_HOME).toBe(
      toml!.path.replace("/opt/optio/", "/home/agent/optio/").replace(/\/config\.toml$/, ""),
    );
    for (const name of ["db", "docs", "files"])
      expect(toml!.content).toContain(`[mcp_servers.${name}]`);
    expect(toml!.content).toContain("/data");

    // Only Codex gets one; nothing else changes for Claude Code.
    const claude = await build({
      agentType: "claude-code",
      repoUrl: w.repoUrl,
      workspaceId: w.ws.id,
      ownerUserId: null,
    });
    expect(filesOf(claude).some((f) => f.path.endsWith("/config.toml"))).toBe(false);
    expect(claude.OPTIO_CODEX_HOME).toBeUndefined();
  });

  it("applies the work's settings: added, left out, and its own setup commands", async () => {
    const w = await world();
    const env = await build({
      repoUrl: w.repoUrl,
      agentType: "claude-code",
      workspaceId: w.ws.id,
      ownerUserId: null,
      settings: {
        mcpServers: { add: [w.ofOther.id], remove: [w.global.id] },
        connections: { add: [w.unassigned.id, w.personal.id], remove: [w.assigned.id] },
        skills: { add: [w.otherSkill.id] },
        setupCommands: "npm ci",
      },
    });
    const mcp = mcpOf(env);
    // Organization work never gets someone's personal connection, even when asked.
    expect(Object.keys(mcp).sort()).toEqual(["db", "metrics", "sentry"]);
    expect(mcp.sentry).toMatchObject({ env: { SENTRY_ORG: "acme" } });
    expect(env.OPTIO_MCP_INSTALL_COMMANDS).toBe("npm i -g m");
    expect(skillPaths(env).sort()).toEqual([
      ".claude/commands/release.md",
      ".claude/commands/triage.md",
    ]);
    expect(env.OPTIO_WORK_SETUP_COMMANDS).toBe("npm ci");
  });

  it("lets personal work add its owner's own connection", async () => {
    const w = await world();
    const env = await build({
      repoUrl: null,
      agentType: "claude-code",
      workspaceId: w.ws.id,
      ownerUserId: w.owner.id,
      settings: { connections: { add: [w.personal.id] } },
    });
    expect(Object.keys(mcpOf(env)).sort()).toEqual(["docs", "files", "mine"]);
  });

  it("ignores another workspace's ids", async () => {
    const w = await world();
    const elsewhere = await insertWorkspace();
    const foreign = await createMcpServer({ name: "foreign", command: "x" }, elsewhere.id);
    const env = await build({
      repoUrl: null,
      agentType: "claude-code",
      workspaceId: w.ws.id,
      ownerUserId: null,
      settings: { mcpServers: { add: [foreign.id] } },
    });
    expect(Object.keys(mcpOf(env))).not.toContain("foreign");
  });
});

describe("buildAgentEnvironment — commands and untrusted pods", () => {
  it("a command gets only its setup commands and the files it was handed", async () => {
    const w = await world();
    const env = await buildAgentEnvironment(
      {
        repoUrl: null,
        agentType: null,
        workspaceId: w.ws.id,
        ownerUserId: null,
        settings: { mcpServers: { add: [w.ofOther.id] }, setupCommands: "make deps" },
      },
      logger,
      [{ path: "notes.txt", content: "hi" }],
    );
    expect(filesOf(env)).toEqual([{ path: "notes.txt", content: "hi" }]);
    expect(env.OPTIO_WORK_SETUP_COMMANDS).toBe("make deps");
    expect(env.OPTIO_MCP_INSTALL_COMMANDS).toBeUndefined();
  });

  it("a pod reading untrusted input gets its connections without credentials", async () => {
    const w = await world();
    const env = await build({
      repoUrl: w.repoUrl,
      agentType: "claude-code",
      workspaceId: w.ws.id,
      ownerUserId: null,
      settings: { connections: { add: [w.unassigned.id] } },
      connectionSecrets: false,
    });
    const mcp = mcpOf(env);
    expect(mcp.sentry).toBeDefined();
    expect(mcp.sentry).not.toHaveProperty("env");
  });
});

describe("environmentOptions", () => {
  it("lists what the work could get, the defaults marked and first", async () => {
    const w = await world();
    const options = await environmentOptions({
      repoUrl: w.repoUrl,
      agentType: "claude-code",
      workspaceId: w.ws.id,
      ownerUserId: null,
    });
    const pick = (items: { name: string; default: boolean; scope: string }[]) =>
      items.map((i) => [i.name, i.default, i.scope]);
    expect(pick(options.mcpServers)).toEqual([
      ["db", true, "repo"],
      ["docs", true, "global"],
      ["metrics", false, "other repo"],
    ]);
    // Someone's personal connection isn't offered to organization work.
    expect(pick(options.connections)).toEqual([
      ["files", true, "assigned"],
      ["sentry", false, "workspace"],
    ]);
    expect(pick(options.skills)).toEqual([
      ["release", true, "global"],
      ["triage", false, "other repo"],
    ]);
    // An unregistered repo has no settings of its own to start from.
    expect(options.repo).toBeNull();

    const mine = await environmentOptions({
      repoUrl: null,
      agentType: "claude-code",
      workspaceId: w.ws.id,
      ownerUserId: w.owner.id,
    });
    expect(mine.connections.map((c) => c.name)).toContain("mine");
  });
});
