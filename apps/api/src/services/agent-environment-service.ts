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
import { getConnectionsForTask, listConnections } from "./connection-service.js";
import { buildMcpJsonContent, getMcpServersForTask, listMcpServers } from "./mcp-server-service.js";
import { buildSkillSetupFiles, getSkillsForTask, listSkills } from "./skill-service.js";
import { getInstalledSkillsForTask, listInstalledSkills } from "./installed-skill-service.js";
import { getRepoByUrl } from "./repo-service.js";
import { retrieveSecretWithFallback } from "./secret-service.js";
import { canUse } from "./ownership.js";

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
 * A connection as an MCP server entry: its provider's command, its env mapped
 * from the connection's config (a `${{SECRET}}` reference, or a config key
 * named like a secret, is resolved), and `{{key}}` args filled from config.
 */
async function connectionMcpEntry(
  conn: ResolvedConnection,
  input: AgentEnvironmentInput,
): Promise<McpEntry | null> {
  const cfg = conn.mcpConfig;
  if (!cfg) return null;
  const env: Record<string, string> = {};
  const mapping = input.connectionSecrets === false ? {} : cfg.envMapping;
  for (const [envKey, configKey] of Object.entries(mapping)) {
    const value = conn.config[configKey];
    let resolved: string | undefined;
    if (typeof value === "string" && value.startsWith("${{") && value.endsWith("}}")) {
      resolved =
        (await connectionSecret(value.slice(3, -2).trim(), input)) ??
        (await connectionSecret(configKey, input));
    } else if (typeof value === "string") {
      resolved = value;
    } else {
      resolved = await connectionSecret(configKey, input);
    }
    if (resolved !== undefined) env[envKey] = resolved;
  }
  const args = cfg.args.map((arg) =>
    arg.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
      const val = conn.config[key];
      return typeof val === "string" ? val : arg;
    }),
  );
  return { command: cfg.command, args, ...(Object.keys(env).length > 0 ? { env } : {}) };
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
    if (!entry) continue;
    mcp[conn.connectionName] = entry;
    if (conn.mcpConfig?.installCommand) install.push(conn.mcpConfig.installCommand);
  }
  if (Object.keys(mcp).length > 0) {
    setupFiles.push({ path: ".mcp.json", content: JSON.stringify({ mcpServers: mcp }, null, 2) });
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
 * What the Where section offers for a piece of pod work: every connection,
 * MCP server, and skill its agent could get, each marked on when the repo and
 * the workspace give it by default. Personal connections show only to their
 * owner's work.
 */
export async function environmentOptions(
  input: Omit<AgentInput, "settings">,
): Promise<WorkEnvironmentOptions> {
  const scope = scopeOf(input.repoUrl);
  const mayUse = usable({ ...input, settings: null });
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
