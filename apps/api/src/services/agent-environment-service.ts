/**
 * What an agent finds in its pod besides the code: MCP servers, connections
 * (served to it as MCP servers), custom and marketplace skills, and the
 * work's own setup commands. Built the same way for every kind of pod work —
 * a Repo Task, a code review, a Job run, a persistent agent's turn — so each
 * gets the same environment, not just the kinds that once had a repo.
 *
 * The repo's and the workspace's settings are the defaults: global MCP
 * servers and skills plus the repo's own, and the connections whose
 * assignments cover the repo and the agent. The work's `WorkSettings` add to
 * them or take from them (`packages/shared/src/work/settings.ts`).
 */
import {
  loadWithOverrides,
  type AgentContainerConfig,
  type CustomSkillConfig,
  type InstalledSkillConfig,
  type McpServerConfig,
  type ResolvedConnection,
  type WorkEnvironmentItem,
  type WorkEnvironmentOptions,
  type WorkSettings,
} from "@optio/shared";
import type { logger } from "../logger.js";
import { getConnectionsForTask, isSecretRef, listConnections } from "./connection-service.js";
import {
  connectionSlug,
  parseArgLines,
  parseEnvLines,
  renderEnvTemplates,
  type TemplateLookup,
} from "../utils/connection-template.js";
import { isReservedPodEnvName, VALID_ENV_NAME } from "../utils/pod-env.js";
import { buildMcpJsonContent, getMcpServersForTask, listMcpServers } from "./mcp-server-service.js";
import { buildSkillSetupFiles, getSkillsForTask, listSkills } from "./skill-service.js";
import { getInstalledSkillsForTask, listInstalledSkills } from "./installed-skill-service.js";
import { getRepoByUrl } from "./repo-service.js";
import { retrieveSecretWithFallback } from "./secret-service.js";
import { canUse, type Actor } from "./ownership.js";
import { connectionCatalog } from "./connection-catalog-service.js";
import { codexMcpConfigToml, OPTIO_CODEX_HOME } from "../utils/codex-config.js";
import {
  carriesEnv,
  copilotMcpConfigJson,
  cursorMcpJson,
  geminiSettingsJson,
  OPTIO_COPILOT_MCP_CONFIG,
  OPTIO_GEMINI_HOME,
  OPTIO_OPENCODE_CONFIG,
  OPTIO_RUN_HOME,
  opencodeConfigJson,
  runHome,
} from "../utils/harness-config.js";

/** A file written into the agent's working directory before it starts. */
type SetupFile = NonNullable<AgentContainerConfig["setupFiles"]>[number];

export interface AgentEnvironmentInput {
  /** The repo the work runs in; null for work with no checkout (a Job, an agent). */
  repoUrl: string | null;
  /** The agent runtime; null for a command (it gets only its setup commands). */
  agentType: string | null;
  workspaceId: string | null;
  /** Personal work's owner: personal connections and secrets reach only their owner's work. */
  ownerUserId: string | null;
  settings?: WorkSettings | null;
  /**
   * False for a pod that reads untrusted input (an external PR's diff): its
   * connections come without their credentials.
   */
  connectionSecrets?: boolean;
  /**
   * The run this environment is for (a task, a Job run, an agent's turn):
   * names its home under the agent's home (`utils/harness-config.ts`), so a
   * retry lands in the same place. A random name without one.
   */
  runId?: string | null;
}

type McpEntry = { command: string; args: string[]; env?: Record<string, string> };
type Log = Pick<typeof logger, "info" | "warn">;

/** The scope MCP servers and skills match: no repo matches only the global ones. */
const scopeOf = (repoUrl: string | null) => repoUrl ?? "";

/** What an agent runtime gets for this work: the defaults with its overrides applied. */
type AgentInput = AgentEnvironmentInput & { agentType: string };

/** Whether the work (by its owner) may use a private row — see ownership.ts. */
const usable = (input: AgentInput) => (row: { ownerUserId?: string | null }) =>
  canUse(row.ownerUserId, input.ownerUserId);

function mcpServersFor(input: AgentInput): Promise<McpServerConfig[]> {
  return loadWithOverrides(
    getMcpServersForTask(scopeOf(input.repoUrl), input.workspaceId, input.ownerUserId),
    async () =>
      (await listMcpServers(undefined, input.workspaceId)).filter(
        (s) => s.enabled && usable(input)(s),
      ),
    (s) => s.id,
    input.settings?.mcpServers,
  );
}

function skillsFor(input: AgentInput): Promise<CustomSkillConfig[]> {
  return loadWithOverrides(
    getSkillsForTask(scopeOf(input.repoUrl), input.workspaceId, input.agentType, input.ownerUserId),
    async () =>
      (await listSkills(undefined, input.workspaceId)).filter((s) => s.enabled && usable(input)(s)),
    (s) => s.id,
    input.settings?.skills,
  );
}

/** Marketplace skills: Claude Code only, and only once synced. */
async function installedSkillsFor(input: AgentInput): Promise<InstalledSkillConfig[]> {
  if (input.agentType !== "claude-code") return [];
  return loadWithOverrides(
    getInstalledSkillsForTask(
      scopeOf(input.repoUrl),
      input.workspaceId,
      input.agentType,
      input.ownerUserId,
    ),
    async () =>
      (await listInstalledSkills(undefined, input.workspaceId)).filter(
        (s) => s.enabled && s.resolvedSha && usable(input)(s),
      ),
    (s) => s.id,
    input.settings?.skills,
  );
}

function connectionsFor(input: AgentInput): Promise<ResolvedConnection[]> {
  return getConnectionsForTask(
    scopeOf(input.repoUrl),
    input.agentType,
    input.workspaceId,
    input.ownerUserId,
    input.settings?.connections,
  );
}

/**
 * A secret for a connection's MCP server: the work's repo scope first, then
 * global — each through the owner / workspace / global fallback.
 */
async function connectionSecret(
  name: string,
  input: AgentEnvironmentInput,
): Promise<string | undefined> {
  const scopes = input.repoUrl ? [input.repoUrl, "global"] : ["global"];
  for (const scope of scopes) {
    try {
      return await retrieveSecretWithFallback(name, scope, input.workspaceId, input.ownerUserId);
    } catch {
      // Try the next scope.
    }
  }
  return undefined;
}

/**
 * The connection's value for a config key, for the provider's templates:
 * `name` is the connection's name; a secret field comes from the encrypted
 * store; a `${{NAME}}` reference resolves to that stored secret (repo scope,
 * then global, through the owner / workspace fallback); otherwise the plain
 * config value, else the form's default, else a secret named like the key.
 * With `connectionSecrets: false` (a pod reading untrusted input) nothing
 * secret is ever resolved.
 */
async function connectionValue(
  conn: ResolvedConnection,
  key: string,
  input: AgentEnvironmentInput,
): Promise<string | undefined> {
  if (key === "name") return conn.connectionName;
  const secretsAllowed = input.connectionSecrets !== false;
  if (secretsAllowed && conn.secrets[key] !== undefined) return conn.secrets[key];
  const value = conn.config[key];
  if (isSecretRef(value)) {
    if (!secretsAllowed) return undefined;
    return (
      (await connectionSecret(value.slice(3, -2).trim(), input)) ??
      (await connectionSecret(key, input))
    );
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return conn.configDefaults[key];
}

/**
 * A connection as an MCP server entry: its provider's command, its env
 * mapped from the connection's config (`envMapping`) plus the provider's
 * static `{{key}}` env templates, and `{{key}}` args filled from config. A
 * provider whose tools have an `enabledBy` switch gives none while it is
 * off. A custom MCP server is built from the connection's own fields.
 */
async function connectionMcpEntry(
  conn: ResolvedConnection,
  input: AgentEnvironmentInput,
): Promise<(McpEntry & { installCommand?: string }) | null> {
  if (conn.providerSlug === "custom-mcp") return customMcpEntry(conn, input);
  const cfg = conn.mcpConfig;
  if (!cfg) return null;
  if (cfg.enabledBy && conn.config[cfg.enabledBy] !== true) return null;
  const env: Record<string, string> = {};
  const mapping = input.connectionSecrets === false ? {} : cfg.envMapping;
  for (const [envKey, configKey] of Object.entries(mapping)) {
    const resolved =
      (await connectionValue(conn, configKey, input)) ??
      (input.connectionSecrets === false ? undefined : await connectionSecret(configKey, input));
    if (resolved !== undefined) env[envKey] = resolved;
  }
  if (cfg.env) {
    const lookup = await templateLookup(conn, Object.values(cfg.env), input);
    Object.assign(env, renderEnvTemplates(cfg.env, lookup));
  }
  const args = cfg.args.map((arg) =>
    arg.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
      const val = conn.config[key];
      return typeof val === "string" ? val : arg;
    }),
  );
  return {
    command: cfg.command,
    args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(cfg.installCommand ? { installCommand: cfg.installCommand } : {}),
  };
}

/** A hand-written MCP server (the `custom-mcp` provider): command, args by line, `KEY=VALUE` env lines. */
async function customMcpEntry(
  conn: ResolvedConnection,
  input: AgentEnvironmentInput,
): Promise<(McpEntry & { installCommand?: string }) | null> {
  const command = typeof conn.config.command === "string" ? conn.config.command.trim() : "";
  if (!command) return null;
  const raw = parseEnvLines(typeof conn.config.env === "string" ? conn.config.env : undefined);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isSecretRef(v)) {
      if (input.connectionSecrets === false) continue;
      const resolved = await connectionSecret(v.slice(3, -2).trim(), input);
      if (resolved !== undefined) env[k] = resolved;
    } else {
      env[k] = v;
    }
  }
  const installCommand =
    typeof conn.config.installCommand === "string" ? conn.config.installCommand.trim() : "";
  return {
    command,
    args: parseArgLines(typeof conn.config.args === "string" ? conn.config.args : undefined),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(installCommand ? { installCommand } : {}),
  };
}

/** A lookup over every key the given templates mention, resolved once. */
async function templateLookup(
  conn: ResolvedConnection,
  templates: string[],
  input: AgentEnvironmentInput,
): Promise<TemplateLookup> {
  const keys = new Set<string>();
  for (const t of templates) for (const m of t.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) keys.add(m[1]);
  const values = new Map<string, string | undefined>();
  for (const key of keys) values.set(key, await connectionValue(conn, key, input));
  return (key) => values.get(key);
}

/**
 * The vars a work's connections export into the agent's own shell (the
 * provider's `shellEnv`, for connections that export it): rendered from the
 * connection's values, a var left out when nothing fills it. None for a pod
 * reading untrusted input. Workers spread this last, so a connection's
 * `AWS_*` beats the deployment's.
 */
export async function connectionShellEnv(
  input: AgentEnvironmentInput,
): Promise<Record<string, string>> {
  if (!input.agentType || input.connectionSecrets === false) return {};
  const conns = await connectionsFor({ ...input, agentType: input.agentType });
  const env: Record<string, string> = {};
  for (const conn of conns) {
    if (!conn.shellEnv || !conn.exportShellEnv) continue;
    const lookup = await templateLookup(conn, Object.values(conn.shellEnv), input);
    for (const [name, value] of Object.entries(renderEnvTemplates(conn.shellEnv, lookup))) {
      if (!VALID_ENV_NAME.test(name) || isReservedPodEnvName(name)) continue;
      env[name] = value;
    }
  }
  return env;
}

/**
 * A connection's note as a skill the agent discovers:
 * `.claude/skills/connection-<slug>/SKILL.md` with the frontmatter Claude
 * Code reads (name, description).
 */
function connectionNoteFile(conn: ResolvedConnection): SetupFile | null {
  const note = conn.note?.trim();
  if (!note) return null;
  const slug = connectionSlug(conn.connectionName);
  const description = `How to use ${conn.connectionName} (${conn.providerName})`;
  const content = [
    "---",
    `name: connection-${slug}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${conn.connectionName}`,
    "",
    note,
    "",
  ].join("\n");
  return { path: `.claude/skills/connection-${slug}/SKILL.md`, content };
}

/**
 * The env every pod run of this work gets: `OPTIO_SETUP_FILES` (`.mcp.json`
 * — the MCP servers, then the connections, which win on a name clash — the
 * skills' files, and any `extraFiles` the runtime's adapter wants written),
 * the MCP install commands, and the work's own setup commands. A command
 * (no agent runtime) gets only its setup commands and `extraFiles`.
 */
export async function buildAgentEnvironment(
  input: AgentEnvironmentInput,
  log: Log,
  extraFiles: SetupFile[] = [],
): Promise<Record<string, string>> {
  const agentType = input.agentType;
  const agent = agentType ? { ...input, agentType } : null;
  const [servers, connections, skills, installed] = agent
    ? await Promise.all([
        mcpServersFor(agent),
        connectionsFor(agent),
        skillsFor(agent),
        installedSkillsFor(agent),
      ])
    : [[], [], [], []];

  const setupFiles: SetupFile[] = [...extraFiles];
  const env: Record<string, string> = {};
  const install: string[] = [];

  const mcp: Record<string, McpEntry> = {};
  if (servers.length > 0) {
    const content = await buildMcpJsonContent(servers, input.repoUrl ?? "global");
    Object.assign(
      mcp,
      (JSON.parse(content) as { mcpServers: Record<string, McpEntry> }).mcpServers,
    );
    install.push(...servers.flatMap((s) => (s.installCommand ? [s.installCommand] : [])));
  }
  for (const conn of connections) {
    const entry = await connectionMcpEntry(conn, input);
    if (entry) {
      const { installCommand, ...server } = entry;
      mcp[conn.connectionName] = server;
      if (installCommand) install.push(installCommand);
    }
    const note = connectionNoteFile(conn);
    if (note) setupFiles.push(note);
  }
  if (Object.keys(mcp).length > 0) {
    // The file can carry credentials (a server's env): readable by the agent only.
    const sensitive = Object.values(mcp).some((s) => s.env && Object.keys(s.env).length > 0);
    setupFiles.push({
      path: ".mcp.json",
      content: JSON.stringify({ mcpServers: mcp }, null, 2),
      ...(sensitive ? { sensitive: true } : {}),
    });
    if (agentType) Object.assign(env, harnessMcpFiles(agentType, mcp, setupFiles, input.runId));
    log.info(
      { servers: servers.length, connections: connections.length },
      "Injecting MCP servers and connections",
    );
  }
  if (install.length > 0) env.OPTIO_MCP_INSTALL_COMMANDS = install.join(" && ");

  if (skills.length > 0) {
    setupFiles.push(...buildSkillSetupFiles(skills));
    log.info({ count: skills.length, agentType }, "Injecting custom skills");
  }
  if (installed.length > 0) {
    const { readInstalledSkillFiles } = await import("../workers/skill-sync-worker.js");
    let injected = 0;
    for (const skill of installed) {
      try {
        const files = await readInstalledSkillFiles(skill.resolvedSha!, skill.subpath);
        for (const f of files) {
          setupFiles.push({
            path: `.claude/skills/${skill.name}/${f.relativePath}`,
            content: "",
            contentBase64: f.content.toString("base64"),
            executable: f.executable,
          });
        }
        injected++;
      } catch (err) {
        log.warn(
          { err, skillId: skill.id, name: skill.name },
          "Skipping installed skill — cache miss or read error",
        );
      }
    }
    log.info({ injected, total: installed.length }, "Injecting marketplace skills");
  }

  if (input.settings?.setupCommands) env.OPTIO_WORK_SETUP_COMMANDS = input.settings.setupCommands;
  // The exec scripts decode this (`WRITE_SETUP_FILES` in utils/pod-env.ts).
  if (setupFiles.length > 0) {
    env.OPTIO_SETUP_FILES = Buffer.from(JSON.stringify(setupFiles)).toString("base64");
  }
  return env;
}

/**
 * The servers in the file and shape the run's agent runtime reads
 * (`utils/harness-config.ts`), pushed onto `setupFiles`; the env the launch
 * lines turn into the runtime's own setting. Only Claude Code reads
 * `.mcp.json`; every other runtime gets a file of its own under the run's
 * home (`OPTIO_RUN_HOME`, removed when the run ends), except Cursor, whose
 * project file lives in the working directory and is merged into the repo's
 * own when it has one.
 */
function harnessMcpFiles(
  agentType: string,
  mcp: Record<string, McpEntry>,
  setupFiles: SetupFile[],
  runId: string | null | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  const sensitive = carriesEnv(mcp);
  const own = (path: string, content: string): SetupFile => ({
    path,
    content,
    ...(sensitive ? { sensitive: true } : {}),
  });
  const home = runHome(runId);
  switch (agentType) {
    case "codex": {
      // Codex also writes its sessions into CODEX_HOME: always the run's own.
      setupFiles.push({
        path: `${home.setupDir}/codex/config.toml`,
        content: codexMcpConfigToml(mcp),
        sensitive: true,
      });
      env[OPTIO_CODEX_HOME] = `${home.podDir}/codex`;
      env[OPTIO_RUN_HOME] = home.podDir;
      break;
    }
    case "gemini": {
      // GEMINI_CLI_HOME moves the whole `.gemini` directory, so the adapter's
      // settings (auth, approval mode, turn limit) move into the run's home
      // with the servers, as the one user settings file Gemini reads.
      const at = setupFiles.findIndex((f) => f.path === GEMINI_USER_SETTINGS);
      let base: Record<string, unknown> = {};
      if (at >= 0) {
        try {
          base = JSON.parse(setupFiles[at].content) as Record<string, unknown>;
        } catch {
          base = {};
        }
        setupFiles.splice(at, 1);
      }
      setupFiles.push(
        own(`${home.setupDir}/gemini/.gemini/settings.json`, geminiSettingsJson(base, mcp)),
      );
      env[OPTIO_GEMINI_HOME] = `${home.podDir}/gemini`;
      env[OPTIO_RUN_HOME] = home.podDir;
      break;
    }
    case "opencode": {
      setupFiles.push(own(`${home.setupDir}/opencode/opencode.json`, opencodeConfigJson(mcp)));
      env[OPTIO_OPENCODE_CONFIG] = `${home.podDir}/opencode/opencode.json`;
      env[OPTIO_RUN_HOME] = home.podDir;
      break;
    }
    case "copilot": {
      setupFiles.push(own(`${home.setupDir}/copilot/mcp-config.json`, copilotMcpConfigJson(mcp)));
      env[OPTIO_COPILOT_MCP_CONFIG] = `${home.podDir}/copilot/mcp-config.json`;
      env[OPTIO_RUN_HOME] = home.podDir;
      break;
    }
    case "cursor": {
      // Cursor reads the project's file (and ~/.cursor/mcp.json, which no
      // setting moves): merged into the repo's own, and never committed.
      setupFiles.push({ ...own(".cursor/mcp.json", cursorMcpJson(mcp)), merge: "json" });
      break;
    }
    default:
      break;
  }
  return env;
}

/** Where the Gemini adapter writes the run's user settings (gemini.ts). */
const GEMINI_USER_SETTINGS = "/home/agent/.gemini/settings.json";

/**
 * What the Where section offers for a piece of pod work: every connection,
 * MCP server, and skill its agent could get, each marked on when the repo and
 * the workspace give it by default. Personal connections show only to their
 * owner's work.
 */
export async function environmentOptions(
  input: Omit<AgentInput, "settings">,
  actor?: Actor,
): Promise<WorkEnvironmentOptions> {
  const scope = scopeOf(input.repoUrl);
  const mayUse = usable({ ...input, settings: null });
  const viewer: Actor = actor ?? {
    userId: input.ownerUserId,
    workspaceId: input.workspaceId,
    isAdmin: false,
  };
  const catalog = connectionCatalog(viewer, {
    repoUrl: input.repoUrl,
    agentType: input.agentType,
    ownerUserId: input.ownerUserId,
  });
  const [defaultServers, allServers, defaultConns, allConns, defaultSkills, allSkills] =
    await Promise.all([
      getMcpServersForTask(scope, input.workspaceId, input.ownerUserId),
      listMcpServers(undefined, input.workspaceId),
      connectionsFor(input),
      listConnections(input.workspaceId),
      Promise.all([
        getSkillsForTask(scope, input.workspaceId, input.agentType, input.ownerUserId),
        installedSkillsFor({ ...input, settings: null }),
      ]),
      Promise.all([
        listSkills(undefined, input.workspaceId),
        input.agentType === "claude-code"
          ? listInstalledSkills(undefined, input.workspaceId)
          : Promise.resolve([] as InstalledSkillConfig[]),
      ]),
    ]);
  const scopeLabel = (s: string) =>
    s === "global" ? "global" : s === input.repoUrl ? "repo" : "other repo";

  const on = new Set(defaultServers.map((s) => s.id));
  const mcpServers: WorkEnvironmentItem[] = allServers
    .filter((s) => s.enabled && mayUse(s))
    .map((s) => ({
      id: s.id,
      name: s.name,
      detail: [s.command, ...s.args].join(" "),
      scope: scopeLabel(s.scope),
      default: on.has(s.id),
      ...(s.ownerUserId ? { private: true } : {}),
    }));

  const assigned = new Set(defaultConns.map((c) => c.connectionId));
  const connections: WorkEnvironmentItem[] = allConns
    .filter((c) => c.enabled && mayUse(c))
    .map((c) => ({
      id: c.id,
      name: c.name,
      detail: c.provider?.name ?? null,
      scope: assigned.has(c.id) ? "assigned" : "workspace",
      default: assigned.has(c.id),
      ...(c.ownerUserId ? { private: true } : {}),
    }));

  const [custom, installed] = defaultSkills;
  const skillOn = new Set([...custom, ...installed].map((s) => s.id));
  const [allCustom, allInstalled] = allSkills;
  const skills: WorkEnvironmentItem[] = [
    ...allCustom.filter((s) => s.enabled && mayUse(s)),
    ...allInstalled.filter((s) => s.enabled && s.resolvedSha && mayUse(s)),
  ].map((s) => ({
    id: s.id,
    name: s.name,
    detail: s.description ?? null,
    scope: scopeLabel(s.scope),
    default: skillOn.has(s.id),
    ...(s.ownerUserId ? { private: true } : {}),
  }));

  const byDefaultThenName = (a: WorkEnvironmentItem, b: WorkEnvironmentItem) =>
    Number(b.default) - Number(a.default) || a.name.localeCompare(b.name);
  const repo = input.repoUrl ? await getRepoByUrl(input.repoUrl, input.workspaceId) : null;
  return {
    connections: connections.sort(byDefaultThenName),
    mcpServers: mcpServers.sort(byDefaultThenName),
    skills: skills.sort(byDefaultThenName),
    catalog: await catalog,
    repo: repo
      ? {
          setupCommands: repo.setupCommands ?? null,
          reviewEnabled: repo.reviewEnabled,
          reviewTrigger: repo.reviewTrigger ?? null,
          cautiousMode: repo.cautiousMode,
          maxAutoResumes: repo.maxAutoResumes ?? null,
        }
      : null,
  };
}
