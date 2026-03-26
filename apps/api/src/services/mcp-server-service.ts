import { eq, and, or, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { mcpServers } from "../db/schema.js";
import type { McpServerConfig } from "@optio/shared";
import { retrieveSecret } from "./secret-service.js";

export async function listMcpServers(
  scope?: string,
  workspaceId?: string | null,
): Promise<McpServerConfig[]> {
  const conditions = [];
  if (scope) conditions.push(eq(mcpServers.scope, scope));
  if (workspaceId) {
    conditions.push(or(eq(mcpServers.workspaceId, workspaceId), isNull(mcpServers.workspaceId))!);
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
): Promise<McpServerConfig[]> {
  const conditions = [
    eq(mcpServers.enabled, true),
    or(eq(mcpServers.scope, "global"), eq(mcpServers.scope, repoUrl))!,
  ];
  if (workspaceId) {
    conditions.push(or(eq(mcpServers.workspaceId, workspaceId), isNull(mcpServers.workspaceId))!);
  }

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

/**
 * Resolve ${{SECRET_NAME}} references in MCP server env vars against Optio's secrets.
 */
export async function resolveSecretRefs(
  env: Record<string, string>,
  repoUrl: string,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  const secretRefPattern = /\$\{\{([^}]+)\}\}/g;

  for (const [key, value] of Object.entries(env)) {
    let resolvedValue = value;
    const matches = [...value.matchAll(secretRefPattern)];
    for (const match of matches) {
      const secretName = match[1].trim();
      try {
        // Try repo-scoped first, fall back to global
        let secretValue: string;
        try {
          secretValue = await retrieveSecret(secretName, repoUrl);
        } catch {
          secretValue = await retrieveSecret(secretName, "global");
        }
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
): Promise<string> {
  const mcpConfig: Record<
    string,
    { command: string; args: string[]; env?: Record<string, string> }
  > = {};

  for (const server of servers) {
    // Resolve secret refs in args
    const resolvedArgs: string[] = [];
    const secretRefPattern = /\$\{\{([^}]+)\}\}/g;
    for (const arg of server.args) {
      let resolvedArg = arg;
      const matches = [...arg.matchAll(secretRefPattern)];
      for (const match of matches) {
        const secretName = match[1].trim();
        try {
          let secretValue: string;
          try {
            secretValue = await retrieveSecret(secretName, repoUrl);
          } catch {
            secretValue = await retrieveSecret(secretName, "global");
          }
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
      entry.env = await resolveSecretRefs(server.env, repoUrl);
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
    args: (row.args as string[]) ?? [],
    env: row.env as Record<string, string> | null,
    installCommand: row.installCommand,
    scope: row.scope,
    repoUrl: row.repoUrl,
    workspaceId: row.workspaceId,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
