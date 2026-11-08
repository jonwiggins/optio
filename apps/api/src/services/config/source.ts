/**
 * The configuration directory as a source: declared by `OPTIO_CONFIG_DIR`
 * (+ `OPTIO_CONFIG_WORKSPACE`, `OPTIO_CONFIG_PRUNE`, `OPTIO_CONFIG_INTERVAL`),
 * mirrored into `config_sources` so it has an id, a status and a place in
 * Settings, read every interval by the sync worker, and applied.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import type { ConfigApplyResult, ConfigSourceView, ConfigStatus } from "@optio/shared";
import { db } from "../../db/client.js";
import { configSources, workspaces } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { applyManifests, type ConfigSourceRow } from "./apply.js";
import { readManifestDirectory } from "./files.js";
import { envConfigSource, type EnvConfigSource } from "./env.js";
import { isAuthDisabled } from "../oauth/index.js";
import { withLease } from "../lease-service.js";

export { envConfigSource } from "./env.js";

/** The one directory source's name, as Settings shows it. */
const CONFIG_SOURCE_NAME = "config directory";

/** The workspace a slug names, else the oldest one (the organization's, as the sign-in bootstrap picks). */
async function resolveSourceWorkspaceId(slug: string | null): Promise<string | null> {
  if (slug) {
    const [ws] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, slug));
    return ws?.id ?? null;
  }
  const [oldest] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .orderBy(asc(workspaces.createdAt))
    .limit(1);
  return oldest?.id ?? null;
}

async function sourceRow(workspaceId: string | null): Promise<ConfigSourceRow | null> {
  const [row] = await db
    .select()
    .from(configSources)
    .where(
      and(
        workspaceId
          ? eq(configSources.workspaceId, workspaceId)
          : isNull(configSources.workspaceId),
        eq(configSources.name, CONFIG_SOURCE_NAME),
      ),
    );
  return row ?? null;
}

/**
 * The directory source's row, created or brought up to date from the env.
 * Null when config as code is off, or the workspace it names doesn't exist
 * (yet — a fresh install has none until someone signs in).
 */
async function ensureEnvSource(): Promise<ConfigSourceRow | null> {
  const env = envConfigSource();
  if (!env) return null;
  // With auth disabled requests carry no workspace and rows are stored under
  // none (whatever workspaces the migrations made): the directory feeds that
  // one tenant, unless a slug says otherwise.
  if (!env.workspace && isAuthDisabled()) return ensureSourceRow(null, env);
  const workspaceId = await resolveSourceWorkspaceId(env.workspace);
  if (!workspaceId) {
    logger.warn(
      { workspace: env.workspace },
      env.workspace
        ? "OPTIO_CONFIG_DIR: no workspace with that slug yet; waiting"
        : "OPTIO_CONFIG_DIR: no workspace yet; waiting for the first sign-in",
    );
    return null;
  }
  return ensureSourceRow(workspaceId, env);
}

async function ensureSourceRow(
  workspaceId: string | null,
  env: EnvConfigSource,
): Promise<ConfigSourceRow | null> {
  const existing = await sourceRow(workspaceId);
  if (existing) {
    if (existing.path === env.dir && existing.prune === env.prune && existing.enabled)
      return existing;
    const [updated] = await db
      .update(configSources)
      .set({ path: env.dir, prune: env.prune, enabled: true, updatedAt: new Date() })
      .where(eq(configSources.id, existing.id))
      .returning();
    return updated;
  }
  const [created] = await db
    .insert(configSources)
    .values({
      workspaceId,
      name: CONFIG_SOURCE_NAME,
      kind: "dir",
      path: env.dir,
      prune: env.prune,
      enabled: true,
      origin: "env",
    })
    .onConflictDoNothing()
    .returning();
  return created ?? (await sourceRow(workspaceId));
}

// One apply at a time across every API instance: a tick and a "Sync now"
// that overlap would race each other's creates. The apply holds the
// `config-sync:apply` lease (services/lease-service.ts); within one process
// callers are also chained, so a tick never contends with its own instance.
const APPLY_LEASE_KEY = "config-sync:apply";
const APPLY_LEASE_TTL_MS = 5 * 60_000;
const APPLY_WAIT_MS = 60_000;

let running: Promise<unknown> = Promise.resolve();

function serialized<T>(run: () => Promise<T>): Promise<T> {
  const next = running.then(run, run);
  running = next.catch(() => {});
  return next;
}

export class ConfigApplyBusyError extends Error {
  constructor() {
    super("Another API instance is applying the configuration directory; try again shortly");
    this.name = "ConfigApplyBusyError";
  }
}

/**
 * Runs `run` under the apply lease. A periodic tick (`wait: false`) skips
 * when another instance holds it — the next tick applies the same files. A
 * person's "Sync now" (`wait: true`) waits up to a minute for the lease
 * and fails with `ConfigApplyBusyError` otherwise.
 */
async function underApplyLease<T>(wait: boolean, run: () => Promise<T>): Promise<T | null> {
  const result = await withLease(APPLY_LEASE_KEY, run, {
    ttlMs: APPLY_LEASE_TTL_MS,
    ...(wait ? { wait: { timeoutMs: APPLY_WAIT_MS, pollMs: 500 } } : {}),
  });
  if (result !== null) return result;
  if (wait) throw new ConfigApplyBusyError();
  logger.debug("config directory: another instance is applying; skipping this tick");
  return null;
}

/**
 * Read the directory and apply it (or plan it). Null when config as code is
 * off, or when `wait` is false and another instance is applying right now.
 */
export async function syncEnvSource(
  opts: { dryRun?: boolean; wait?: boolean } = {},
): Promise<ConfigApplyResult | null> {
  const source = await ensureEnvSource();
  if (!source) return null;
  const wait = opts.wait ?? true;
  return serialized(() =>
    underApplyLease(wait, async () => {
      const dryRun = opts.dryRun ?? false;
      let result: ConfigApplyResult;
      let hash: string | null = null;
      let error: string | null = null;
      try {
        const read = await readManifestDirectory(source.path);
        hash = read.hash;
        result = await applyManifests({
          workspaceId: source.workspaceId,
          manifests: read.manifests,
          dryRun,
          source,
          prune: source.prune,
          priorErrors: read.errors,
        });
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        logger.error({ err, dir: source.path }, "config directory: sync failed");
        result = {
          dryRun,
          source: { id: source.id, name: source.name },
          items: [],
          summary: {
            created: 0,
            updated: 0,
            reverted: 0,
            unchanged: 0,
            adopted: 0,
            replaced: 0,
            pruned: 0,
            errors: 1,
          },
          at: new Date().toISOString(),
        };
      }
      if (!dryRun) {
        await db
          .update(configSources)
          .set({
            lastSyncAt: new Date(),
            lastSyncHash: hash,
            lastSyncError: error,
            lastSyncResult: result,
            updatedAt: new Date(),
          })
          .where(eq(configSources.id, source.id));
        const s = result.summary;
        if (s.created || s.updated || s.replaced || s.pruned || s.errors || error) {
          logger.info({ dir: source.path, ...s, error }, "config directory applied");
        }
      }
      return result;
    }),
  );
}

function toSourceView(row: ConfigSourceRow, intervalMs: number): ConfigSourceView {
  return {
    id: row.id,
    name: row.name,
    kind: "dir",
    path: row.path,
    workspaceId: row.workspaceId,
    prune: row.prune,
    enabled: row.enabled,
    origin: row.origin === "settings" ? "settings" : "env",
    intervalMs,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastSyncHash: row.lastSyncHash,
    lastSyncError: row.lastSyncError,
    lastSync: row.lastSyncResult ?? null,
  };
}

/** `GET /api/config/status` for a workspace. */
export async function configStatus(
  workspaceId: string | null,
  schemaUrl: string,
): Promise<ConfigStatus> {
  const env = envConfigSource();
  if (!env) return { enabled: false, source: null, schemaUrl };
  const row = await sourceRow(workspaceId);
  if (!row) {
    // Configured, but for another workspace (or none exists yet).
    return { enabled: false, source: null, schemaUrl };
  }
  return { enabled: row.enabled, source: toSourceView(row, env.intervalMs), schemaUrl };
}
