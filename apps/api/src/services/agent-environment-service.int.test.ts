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
import {
  buildAgentEnvironment,
  connectionShellEnv,
  environmentOptions,
} from "./agent-environment-service.js";
import { logger } from "../logger.js";
import { createConnection, seedBuiltInProviders, updateConnection } from "./connection-service.js";
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

  it("gives a Codex run the same servers as TOML in a CODEX_HOME under the run's home", async () => {
    const w = await world();
    const runId = "4d1b6c0e-6a2a-4b7e-9a7c-1f2e3d4c5b6a";
    const env = await build({
      agentType: "codex",
      repoUrl: w.repoUrl,
      workspaceId: w.ws.id,
      ownerUserId: null,
      runId,
    });
    expect(Object.keys(mcpOf(env)).sort()).toEqual(["db", "docs", "files"]);
    const files = filesOf(env) as { path: string; content: string; sensitive?: boolean }[];
    const toml = files.find((f) => f.path.endsWith("/config.toml"));
    expect(toml).toBeDefined();
    expect(toml!.sensitive).toBe(true);
    // Named after the run, so a retry lands in the same place.
    expect(toml!.path).toBe(`/opt/optio/runs/${runId}/codex/config.toml`);
    expect(env.OPTIO_CODEX_HOME).toBe(`/home/agent/optio/runs/${runId}/codex`);
    expect(env.OPTIO_RUN_HOME).toBe(`/home/agent/optio/runs/${runId}`);
    for (const name of ["db", "docs", "files"])
      expect(toml!.content).toContain(`[mcp_servers.${name}]`);
    expect(toml!.content).toContain("/data");

    // Without a run id, a random home.
    const anon = await build({
      agentType: "codex",
      repoUrl: w.repoUrl,
      workspaceId: w.ws.id,
      ownerUserId: null,
    });
    expect(anon.OPTIO_RUN_HOME).toMatch(/^\/home\/agent\/optio\/runs\/[0-9a-f]{12}$/);

    // Only the runtimes that read their own file get one; nothing else changes for Claude Code.
    const claude = await build({
      agentType: "claude-code",
      repoUrl: w.repoUrl,
      workspaceId: w.ws.id,
      ownerUserId: null,
      runId,
    });
    expect(filesOf(claude).some((f) => f.path.startsWith("/opt/optio/runs/"))).toBe(false);
    expect(claude.OPTIO_CODEX_HOME).toBeUndefined();
    expect(claude.OPTIO_RUN_HOME).toBeUndefined();
  });

  it("gives Gemini, OpenCode, Copilot and Cursor runs the servers in the file each reads", async () => {
    const w = await world();
    const runId = "7a0f3b2c-1d4e-4f5a-8b6c-9d0e1f2a3b4c";
    const base = { repoUrl: w.repoUrl, workspaceId: w.ws.id, ownerUserId: null, runId };
    type File = { path: string; content: string; sensitive?: boolean; merge?: string };
    const fileAt = (env: Env, path: string) =>
      (filesOf(env) as File[]).find((f) => f.path === path);

    // Gemini: the adapter's own settings (handed in as an extra file at the
    // user settings path) move into the run's home with the servers.
    const geminiEnv = await buildAgentEnvironment({ ...base, agentType: "gemini" }, logger, [
      {
        path: "/home/agent/.gemini/settings.json",
        content: JSON.stringify({ model: { maxSessionTurns: 7 }, telemetry: { enabled: false } }),
      },
      { path: "TASK.md", content: "do it" },
    ]);
    expect(fileAt(geminiEnv, "/home/agent/.gemini/settings.json")).toBeUndefined();
    const settings = fileAt(geminiEnv, `/opt/optio/runs/${runId}/gemini/.gemini/settings.json`)!;
    expect(settings).toBeDefined();
    const gemini = JSON.parse(settings.content);
    expect(gemini.model).toEqual({ maxSessionTurns: 7 });
    expect(gemini.telemetry).toEqual({ enabled: false });
    expect(Object.keys(gemini.mcpServers).sort()).toEqual(["db", "docs", "files"]);
    expect(gemini.mcpServers.files).toMatchObject({ command: "npx", trust: true });
    expect(geminiEnv.OPTIO_GEMINI_HOME).toBe(`/home/agent/optio/runs/${runId}/gemini`);
    expect(geminiEnv.OPTIO_RUN_HOME).toBe(`/home/agent/optio/runs/${runId}`);
    expect(fileAt(geminiEnv, "TASK.md")).toBeDefined();

    // OpenCode: a config file of the run's own, merged by OpenCode after the global one.
    const opencodeEnv = await build({ ...base, agentType: "opencode" });
    const opencode = fileAt(opencodeEnv, `/opt/optio/runs/${runId}/opencode/opencode.json`)!;
    expect(opencode).toBeDefined();
    const oc = JSON.parse(opencode.content);
    expect(Object.keys(oc.mcp).sort()).toEqual(["db", "docs", "files"]);
    expect(oc.mcp.db).toEqual({ type: "local", command: ["db-mcp"], enabled: true });
    expect(oc.mcp.files.command[0]).toBe("npx");
    expect(opencodeEnv.OPTIO_OPENCODE_CONFIG).toBe(
      `/home/agent/optio/runs/${runId}/opencode/opencode.json`,
    );

    // Copilot: an additional MCP config file, every tool of every server on.
    const copilotEnv = await build({ ...base, agentType: "copilot" });
    const copilot = fileAt(copilotEnv, `/opt/optio/runs/${runId}/copilot/mcp-config.json`)!;
    expect(copilot).toBeDefined();
    const cp = JSON.parse(copilot.content).mcpServers;
    expect(Object.keys(cp).sort()).toEqual(["db", "docs", "files"]);
    expect(cp.docs).toEqual({ type: "local", command: "docs-mcp", args: [], tools: ["*"] });
    expect(copilotEnv.OPTIO_COPILOT_MCP_CONFIG).toBe(
      `/home/agent/optio/runs/${runId}/copilot/mcp-config.json`,
    );

    // Cursor: the project's file in the working directory, merged into the repo's own.
    const cursorEnv = await build({ ...base, agentType: "cursor" });
    const cursor = fileAt(cursorEnv, ".cursor/mcp.json")!;
    expect(cursor).toBeDefined();
    expect(cursor.merge).toBe("json");
    expect(Object.keys(JSON.parse(cursor.content).mcpServers).sort()).toEqual([
      "db",
      "docs",
      "files",
    ]);
    expect(cursorEnv.OPTIO_RUN_HOME).toBeUndefined();

    // Every one of them still gets .mcp.json too.
    for (const env of [geminiEnv, opencodeEnv, copilotEnv, cursorEnv])
      expect(Object.keys(mcpOf(env)).sort()).toEqual(["db", "docs", "files"]);
  });

  it("marks a runtime's own file sensitive only when a server carries credentials", async () => {
    const w = await world();
    await createConnection(
      {
        name: "Support Pylon",
        providerSlug: "pylon",
        config: { PYLON_API_TOKEN: "pyl_t", PYLON_API_HOST: "api.eu.usepylon.com" },
        assignments: [{ repoId: null }],
      },
      w.ws.id,
    );
    const base = { repoUrl: null, workspaceId: w.ws.id, ownerUserId: null, runId: "r-1" };
    type File = { path: string; sensitive?: boolean; content: string };
    for (const agentType of ["gemini", "opencode", "copilot", "cursor"]) {
      const files = filesOf(await build({ ...base, agentType })) as File[];
      const own = files.find(
        (f) => f.path.startsWith("/opt/optio/runs/") || f.path === ".cursor/mcp.json",
      )!;
      expect(own.sensitive).toBe(true);
      expect(own.content).toContain("pyl_t");
      // The untrusted pod's copy carries no credentials and is not sensitive.
      const untrusted = filesOf(
        await build({ ...base, agentType, connectionSecrets: false }),
      ) as File[];
      const ownUntrusted = untrusted.find(
        (f) => f.path.startsWith("/opt/optio/runs/") || f.path === ".cursor/mcp.json",
      )!;
      expect(ownUntrusted.content).not.toContain("pyl_t");
    }
  });

  it("renders a provider's manifest: templated MCP env, shell env, the note, a sensitive .mcp.json", async () => {
    const w = await world();
    const pylon = await createConnection(
      {
        name: "Support Pylon",
        providerSlug: "pylon",
        config: { PYLON_API_TOKEN: "pyl_t", PYLON_API_HOST: "api.eu.usepylon.com" },
        assignments: [{ repoId: null }],
      },
      w.ws.id,
    );
    const aws = await createConnection(
      {
        name: "Acme AWS",
        providerSlug: "aws",
        config: {
          AWS_ACCESS_KEY_ID: "AKIA",
          AWS_SECRET_ACCESS_KEY: "sec",
          AWS_REGION: "eu-west-1",
        },
        assignments: [{ repoId: null }],
      },
      w.ws.id,
    );
    const input = {
      agentType: "claude-code",
      repoUrl: null,
      workspaceId: w.ws.id,
      ownerUserId: null,
    };
    const env = await build(input);
    const files = filesOf(env) as { path: string; content: string; sensitive?: boolean }[];
    const mcpFile = files.find((f) => f.path === ".mcp.json")!;
    expect(mcpFile.sensitive).toBe(true);
    const mcp = JSON.parse(mcpFile.content).mcpServers as Record<
      string,
      { command: string; args: string[]; env?: Record<string, string> }
    >;
    expect(mcp["Support Pylon"]).toEqual({
      command: "node",
      args: ["/opt/optio/mcp-bridge.js"],
      env: {
        OPTIO_HTTP_NAME: "Support Pylon",
        OPTIO_HTTP_BASE_URL: "https://api.eu.usepylon.com",
        OPTIO_HTTP_AUTH_VALUE: "Bearer pyl_t",
        OPTIO_HTTP_DESCRIPTION: expect.stringContaining("Pylon"),
      },
    });
    // AWS tools are off until switched on.
    expect(mcp["Acme AWS"]).toBeUndefined();
    expect(files.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        ".claude/skills/connection-support-pylon/SKILL.md",
        ".claude/skills/connection-acme-aws/SKILL.md",
      ]),
    );
    const note = files.find((f) => f.path === ".claude/skills/connection-acme-aws/SKILL.md")!;
    expect(note.content).toContain("name: connection-acme-aws");
    expect(note.content).toContain("aws sts get-caller-identity");

    const shell = await connectionShellEnv(input);
    expect(shell).toEqual({
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "sec",
      AWS_REGION: "eu-west-1",
    });
    // A pod reading untrusted input gets no shell env and no credentials.
    expect(await connectionShellEnv({ ...input, connectionSecrets: false })).toEqual({});
    const untrusted = await build({ ...input, connectionSecrets: false });
    expect(JSON.stringify(filesOf(untrusted))).not.toContain("pyl_t");

    // Tools switched on; shell env switched off.
    await updateConnection(aws.id, { config: { AWS_TOOLS: true }, exportShellEnv: false });
    const env2 = await build(input);
    const mcp2 = JSON.parse(filesOf(env2).find((f) => f.path === ".mcp.json")!.content)
      .mcpServers as Record<string, { command: string; env?: Record<string, string> }>;
    expect(mcp2["Acme AWS"]).toMatchObject({
      command: "uvx",
      env: { AWS_ACCESS_KEY_ID: "AKIA", AWS_REGION: "eu-west-1" },
    });
    expect(await connectionShellEnv(input)).toEqual({});
    expect(pylon.id).toBeDefined();
  });

  it("builds a custom MCP server from the connection's own fields", async () => {
    const w = await world();
    await createConnection(
      {
        name: "my-tools",
        providerSlug: "custom-mcp",
        config: {
          command: "npx",
          args: "-y\n@acme/tools",
          env: "ACME_TOKEN=${{ACME_TOKEN}}\nMODE=prod",
          installCommand: "npm i -g @acme/tools",
        },
        assignments: [{ repoId: null }],
      },
      w.ws.id,
    );
    const env = await build({
      agentType: "claude-code",
      repoUrl: null,
      workspaceId: w.ws.id,
      ownerUserId: null,
    });
    const mcp = mcpOf(env) as Record<
      string,
      { command: string; args: string[]; env?: Record<string, string> }
    >;
    expect(mcp["my-tools"]).toEqual({
      command: "npx",
      args: ["-y", "@acme/tools"],
      env: { MODE: "prod" },
    });
    expect(env.OPTIO_MCP_INSTALL_COMMANDS).toContain("npm i -g @acme/tools");
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
