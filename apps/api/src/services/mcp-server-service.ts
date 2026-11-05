import { eq, and, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { mcpServers } from "../db/schema.js";
import type { McpServerConfig } from "@optio/shared";
import {
  mayUseDeploymentSecrets,
  retrieveSecret,
  WORKSPACE_SECRET_SCOPE,
} from "./secret-service.js";
import { usableBy, visibleOwner, type Actor } from "./ownership.js";
import { workspaceOrDeploymentDefault } from "./deployment-defaults.js";

/**
 * MCP servers in a workspace. With `viewer`, only those they may see: the
 * organization's and their own (an admin sees every one) — services/ownership.ts.
 */
export async function listMcpServers(
  scope?: string,
  workspaceId?: string | null,
  viewer?: Actor,
): Promise<McpServerConfig[]> {
  const conditions = [];
  if (scope) conditions.push(eq(mcpServers.scope, scope));
  const inWorkspace = await workspaceOrDeploymentDefault(
    mcpServers.workspaceId,
    mcpServers.deploymentDefault,
    workspaceId,
  );
  if (inWorkspace) conditions.push(inWorkspace);
  if (viewer) {
    const visible = visibleOwner(mcpServers.ownerUserId, viewer);
    if (visible) conditions.push(visible);
  }

  const query =
    conditions.length > 0
      ? db
          .select()
          .from(mcpServers)
          .where(and(...conditions))
      : db.select().from(mcpServers);
  const rows = await query;
  return rows.map(mapRow);
}

export async function getMcpServer(id: string): Promise<McpServerConfig | null> {
  const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
  return row ? mapRow(row) : null;
}

export async function createMcpServer(
  input: {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    installCommand?: string;
    repoUrl?: string;
    enabled?: boolean;
    /** Null = the organization's; set = one person's private server. */
    ownerUserId?: string | null;
  },
  workspaceId?: string | null,
): Promise<McpServerConfig> {
  const [row] = await db
    .insert(mcpServers)
    .values({
      name: input.name,
      command: input.command,
      args: input.args ?? [],
      env: input.env ?? undefined,
      installCommand: input.installCommand ?? undefined,
      scope: input.repoUrl ?? "global",
      repoUrl: input.repoUrl ?? undefined,
      workspaceId: workspaceId ?? undefined,
      ownerUserId: input.ownerUserId ?? null,
      enabled: input.enabled ?? true,
    })
    .returning();
  return mapRow(row);
}

export async function updateMcpServer(
  id: string,
  input: {
    name?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string> | null;
    installCommand?: string | null;
    enabled?: boolean;
  },
): Promise<McpServerConfig> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.command !== undefined) updates.command = input.command;
  if (input.args !== undefined) updates.args = input.args;
  if (input.env !== undefined) updates.env = input.env;
  if (input.installCommand !== undefined) updates.installCommand = input.installCommand;
  if (input.enabled !== undefined) updates.enabled = input.enabled;

  const [row] = await db.update(mcpServers).set(updates).where(eq(mcpServers.id, id)).returning();
  return mapRow(row);
}

export async function deleteMcpServer(id: string): Promise<void> {
  await db.delete(mcpServers).where(eq(mcpServers.id, id));
}

/**
 * Get all enabled MCP servers for a task (global + repo-scoped).
 * Repo-scoped servers with the same name override global ones.
 */
export async function getMcpServersForTask(
  repoUrl: string,
  workspaceId?: string | null,
  /** The work's owner: a private server reaches only its owner's work. */
  ownerUserId?: string | null,
): Promise<McpServerConfig[]> {
  const conditions = [
    eq(mcpServers.enabled, true),
    or(eq(mcpServers.scope, "global"), eq(mcpServers.scope, repoUrl))!,
    usableBy(mcpServers.ownerUserId, ownerUserId),
  ];
  const inWorkspace = await workspaceOrDeploymentDefault(
    mcpServers.workspaceId,
    mcpServers.deploymentDefault,
    workspaceId,
  );
  if (inWorkspace) conditions.push(inWorkspace);

  const rows = await db
    .select()
    .from(mcpServers)
    .where(and(...conditions));

  // Repo-scoped servers override global ones with the same name
  const byName = new Map<string, McpServerConfig>();
  for (const row of rows) {
    const config = mapRow(row);
    const existing = byName.get(config.name);
    if (!existing || (config.scope !== "global" && existing.scope === "global")) {
      byName.set(config.name, config);
    }
  }
  return Array.from(byName.values());
}

/** Whose secrets an MCP server's `${{NAME}}` references resolve against. */
export interface McpSecretContext {
  /** The workspace of the work the server is for: its repo secrets come first. */
  workspaceId?: string | null;
  /**
   * The workspace the server was added in (null: the deployment's own). The
   * name is that workspace's choice, so the deployment's secrets answer only
   * where `mayUseDeploymentSecrets` allows it.
   */
  definedIn?: string | null;
}

/**
 * The secret an MCP server's `${{NAME}}` names: the repo's (the work's
 * workspace's, then one saved without a workspace), then the global one.
 * The last two are the deployment's own, for servers the founding workspace
 * or the deployment added (`McpSecretContext.definedIn`).
 */
async function serverSecret(
  name: string,
  repoUrl: string,
  ctx: McpSecretContext | undefined,
): Promise<string> {
  const workspaceId = ctx?.workspaceId ?? null;
  if (workspaceId) {
    try {
      return await retrieveSecret(name, repoUrl, workspaceId);
    } catch {
      // Not the repo's: the workspace's own organization secret.
    }
    try {
      return await retrieveSecret(name, WORKSPACE_SECRET_SCOPE, workspaceId);
    } catch {
      // Not this workspace's: the deployment's, if it may.
    }
  }
  if (!(await mayUseDeploymentSecrets(ctx?.definedIn ?? null))) {
    throw new Error(`Secret not found: ${name}`);
  }
  try {
    return await retrieveSecret(name, repoUrl);
  } catch {
    return retrieveSecret(name, "global");
  }
}

/**
 * Resolve ${{SECRET_NAME}} references in MCP server env vars against Optio's secrets.
 */
export async function resolveSecretRefs(
  env: Record<string, string>,
  repoUrl: string,
  ctx?: McpSecretContext,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  const secretRefPattern = /\$\{\{([^}]+)\}\}/g;

  for (const [key, value] of Object.entries(env)) {
    let resolvedValue = value;
    const matches = [...value.matchAll(secretRefPattern)];
    for (const match of matches) {
      const secretName = match[1].trim();
      try {
        const secretValue = await serverSecret(secretName, repoUrl, ctx);
        resolvedValue = resolvedValue.replace(match[0], secretValue);
      } catch {
        // Secret not found — leave the reference as-is so it's visible in logs
      }
    }
    resolved[key] = resolvedValue;
  }
  return resolved;
}

/**
 * Build the .mcp.json file content from a list of MCP server configs.
 * Resolves secret references in env vars.
 */
export async function buildMcpJsonContent(
  servers: McpServerConfig[],
  repoUrl: string,
  ctx?: McpSecretContext,
): Promise<string> {
  const mcpConfig: Record<
    string,
    { command: string; args: string[]; env?: Record<string, string> }
  > = {};

  for (const server of servers) {
    const serverCtx: McpSecretContext = { ...ctx, definedIn: server.workspaceId ?? null };
    // Resolve secret refs in args
    const resolvedArgs: string[] = [];
    const secretRefPattern = /\$\{\{([^}]+)\}\}/g;
    for (const arg of server.args) {
      let resolvedArg = arg;
      const matches = [...arg.matchAll(secretRefPattern)];
      for (const match of matches) {
        const secretName = match[1].trim();
        try {
          const secretValue = await serverSecret(secretName, repoUrl, serverCtx);
          resolvedArg = resolvedArg.replace(match[0], secretValue);
        } catch {
          // Leave as-is
        }
      }
      resolvedArgs.push(resolvedArg);
    }

    const entry: { command: string; args: string[]; env?: Record<string, string> } = {
      command: server.command,
      args: resolvedArgs,
    };

    if (server.env && Object.keys(server.env).length > 0) {
      entry.env = await resolveSecretRefs(server.env, repoUrl, serverCtx);
    }

    mcpConfig[server.name] = entry;
  }

  return JSON.stringify({ mcpServers: mcpConfig }, null, 2);
}

function mapRow(row: typeof mcpServers.$inferSelect): McpServerConfig {
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    args: row.args ?? [],
    env: row.env,
    installCommand: row.installCommand,
    scope: row.scope,
    repoUrl: row.repoUrl,
    workspaceId: row.workspaceId,
    deploymentDefault: row.deploymentDefault,
    ownerUserId: row.ownerUserId,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
