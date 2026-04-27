/**
 * Sync worker for marketplace-sourced skills (`installed_skills`).
 *
 * Two job types:
 *   - "sync-one"  { id }  → on-demand, fired by POST /api/installed-skills/:id/sync
 *   - "sync-due"  {}      → periodic; finds rows with a missing or stale resolved_sha
 *
 * For each row, the worker:
 *   1. Resolves `ref` → SHA via `git ls-remote` (cheap, no clone).
 *   2. If `<cacheDir>/<sha>/` already exists, skips the clone — multiple skills
 *      can share a cache entry when they pin to the same SHA.
 *   3. Otherwise shallow-clones into a temp dir, then renames into place.
 *   4. Walks `<sha>/<subpath>/`, parses SKILL.md frontmatter, sums file sizes,
 *      flags executable files, and writes the manifest back to the row.
 *
 * The cache PVC is mounted at OPTIO_SKILLS_CACHE_DIR (default
 * /opt/optio/skills-cache). The directory layout is content-addressable, so
 * concurrent passes either race-create the same SHA dir or no-op.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Queue, Worker } from "bullmq";
import { parseIntEnv } from "@optio/shared";
import type { InstalledSkillManifest } from "@optio/shared";
import { logger } from "../logger.js";
import { getBullMQConnectionOptions } from "../services/redis-config.js";
import { db } from "../db/client.js";
import { installedSkills } from "../db/schema.js";
import { eq, isNull, or } from "drizzle-orm";
import { recordSyncResult } from "../services/installed-skill-service.js";

const execFileP = promisify(execFile);
const connectionOpts = getBullMQConnectionOptions();

export const skillSyncQueue = new Queue("skill-sync", { connection: connectionOpts });

function cacheDir(): string {
  return process.env.OPTIO_SKILLS_CACHE_DIR ?? "/opt/optio/skills-cache";
}
const CLONE_TIMEOUT_MS = parseIntEnv("OPTIO_SKILL_CLONE_TIMEOUT_MS", 60_000);
const SYNC_INTERVAL_MS = parseIntEnv("OPTIO_SKILL_SYNC_INTERVAL", 300_000); // 5 min
/** Hard cap per skill — anything bigger is rejected to keep OPTIO_SETUP_FILES sane. */
const MAX_SKILL_BYTES = parseIntEnv("OPTIO_SKILL_MAX_BYTES", 1_048_576); // 1 MiB

export function startSkillSyncWorker() {
  // Ensure cache dir exists. mkdir is idempotent.
  fs.mkdir(cacheDir(), { recursive: true }).catch((err) => {
    logger.warn({ err, dir: cacheDir() }, "Could not pre-create skills cache dir");
  });

  // Periodic sweep for rows that need a sync.
  skillSyncQueue.add(
    "sync-due",
    {},
    {
      repeat: { every: SYNC_INTERVAL_MS },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 50 },
    },
  );

  const worker = new Worker(
    "skill-sync",
    async (job) => {
      if (job.name === "sync-due") {
        await syncDue();
      } else if (job.name === "sync-one") {
        const { id } = job.data as { id: string };
        await syncOne(id);
      }
    },
    { connection: connectionOpts, concurrency: 1 },
  );

  worker.on("failed", (job, err) => {
    logger.error({ err, jobName: job?.name, jobId: job?.id }, "skill-sync job failed");
  });

  return worker;
}

/** Find all rows that need syncing and enqueue a sync-one for each. */
async function syncDue(): Promise<void> {
  const rows = await db
    .select({ id: installedSkills.id })
    .from(installedSkills)
    .where(or(isNull(installedSkills.resolvedSha), eq(installedSkills.lastSyncError, "")));
  for (const row of rows) {
    await skillSyncQueue.add("sync-one", { id: row.id }, { removeOnComplete: true });
  }
}

export async function syncOne(id: string): Promise<void> {
  const log = logger.child({ skillId: id });
  const [row] = await db.select().from(installedSkills).where(eq(installedSkills.id, id));
  if (!row) {
    log.warn("skill row vanished before sync");
    return;
  }
  if (!row.enabled) {
    log.info("skill disabled; skipping sync");
    return;
  }

  try {
    const sha = await resolveRefToSha(row.sourceUrl, row.ref);
    const shaDir = path.join(cacheDir(), sha);

    if (!(await pathExists(shaDir))) {
      await cloneIntoCache(row.sourceUrl, sha, shaDir, log);
    } else {
      log.info({ sha }, "cache hit; skipping clone");
    }

    const subpathDir = path.join(shaDir, row.subpath === "." ? "" : row.subpath);
    if (!(await pathExists(subpathDir))) {
      throw new Error(`subpath '${row.subpath}' not found in source@${sha}`);
    }

    const inspected = await inspectSkillDir(subpathDir);
    if (inspected.totalSizeBytes > MAX_SKILL_BYTES) {
      throw new Error(
        `skill exceeds ${MAX_SKILL_BYTES} byte cap (got ${inspected.totalSizeBytes})`,
      );
    }

    await recordSyncResult(id, {
      ok: true,
      resolvedSha: sha,
      manifest: inspected.manifest,
      hasExecutableFiles: inspected.hasExecutableFiles,
      totalSizeBytes: inspected.totalSizeBytes,
    });
    log.info(
      { sha, fileCount: inspected.manifest.files?.length ?? 0, bytes: inspected.totalSizeBytes },
      "installed skill synced",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "installed skill sync failed");
    await recordSyncResult(id, { ok: false, error: msg });
  }
}

async function resolveRefToSha(sourceUrl: string, ref: string): Promise<string> {
  // ls-remote returns "<sha>\trefs/heads/<branch>" lines. We try the requested
  // ref directly and fall back to bare HEAD if the ref doesn't exist.
  const { stdout } = await execFileP("git", ["ls-remote", sourceUrl, ref, `refs/tags/${ref}`], {
    timeout: CLONE_TIMEOUT_MS,
  });
  const line = stdout.trim().split("\n")[0];
  if (line) {
    const sha = line.split(/\s+/)[0];
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  // Fallback: ls-remote with no ref returns HEAD.
  const head = await execFileP("git", ["ls-remote", sourceUrl, "HEAD"], {
    timeout: CLONE_TIMEOUT_MS,
  });
  const headSha = head.stdout.trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error(`could not resolve ref '${ref}' for ${sourceUrl}`);
  }
  return headSha;
}

async function cloneIntoCache(
  sourceUrl: string,
  sha: string,
  destDir: string,
  log: { info: (...args: unknown[]) => void },
): Promise<void> {
  // Keep the temp dir on the SAME filesystem as the cache so the final
  // rename is an atomic intra-filesystem move. /tmp is often a separate
  // tmpfs mount in K8s pods, which would EXDEV on rename.
  const tmpParent = path.join(cacheDir(), ".tmp");
  await fs.mkdir(tmpParent, { recursive: true });
  const tmpRoot = await fs.mkdtemp(path.join(tmpParent, "skill-"));
  const tmpClone = path.join(tmpRoot, "clone");
  try {
    log.info({ sourceUrl, sha }, "shallow-cloning skill source");
    // Clone with depth=1 then check out the exact SHA.
    await execFileP("git", ["clone", "--depth", "1", "--no-tags", sourceUrl, tmpClone], {
      timeout: CLONE_TIMEOUT_MS,
    });
    // Best-effort: fetch + checkout the exact SHA in case the default ref isn't
    // what we resolved (e.g. tag vs branch).
    try {
      await execFileP("git", ["-C", tmpClone, "fetch", "--depth", "1", "origin", sha], {
        timeout: CLONE_TIMEOUT_MS,
      });
      await execFileP("git", ["-C", tmpClone, "checkout", "--detach", sha], {
        timeout: CLONE_TIMEOUT_MS,
      });
    } catch {
      // If fetch-by-sha is unsupported (older servers) the depth-1 clone of
      // the resolved branch should already be at the right SHA.
    }
    // Drop .git to save cache space.
    await fs.rm(path.join(tmpClone, ".git"), { recursive: true, force: true });

    // Atomic move into place. If another worker beat us to it, that's fine.
    await fs.mkdir(path.dirname(destDir), { recursive: true });
    try {
      await fs.rename(tmpClone, destDir);
    } catch (err) {
      if (await pathExists(destDir)) {
        log.info({ sha }, "another worker populated cache concurrently");
      } else {
        throw err;
      }
    }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

interface InspectionResult {
  manifest: InstalledSkillManifest;
  hasExecutableFiles: boolean;
  totalSizeBytes: number;
}

async function inspectSkillDir(dir: string): Promise<InspectionResult> {
  const files: NonNullable<InstalledSkillManifest["files"]> = [];
  let hasExecutableFiles = false;
  let totalSizeBytes = 0;

  async function walk(current: string, rel: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(full, relPath);
      } else if (ent.isFile()) {
        const stat = await fs.stat(full);
        const executable = (stat.mode & 0o111) !== 0;
        if (executable) hasExecutableFiles = true;
        totalSizeBytes += stat.size;
        files.push({ relativePath: relPath, sizeBytes: stat.size, executable });
      }
    }
  }
  await walk(dir, "");

  let frontmatter: Record<string, unknown> | undefined;
  const skillMd = files.find((f) => f.relativePath.toLowerCase() === "skill.md");
  if (skillMd) {
    try {
      const content = await fs.readFile(path.join(dir, skillMd.relativePath), "utf8");
      frontmatter = parseFrontmatter(content);
    } catch {
      // non-fatal — manifest is best-effort
    }
  }

  return {
    manifest: { frontmatter, files },
    hasExecutableFiles,
    totalSizeBytes,
  };
}

/**
 * Tiny YAML-frontmatter parser. Handles `key: value` lines (string values)
 * and ignores anything more complex. Good enough for SKILL.md surfaces like
 * `name`, `description`, `version`. Returns undefined when no frontmatter
 * block is present.
 */
function parseFrontmatter(content: string): Record<string, unknown> | undefined {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*(\n|$)/);
  if (!match) return undefined;
  const out: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    let value: string = m[2];
    // Strip a single layer of surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read materialized files for an installed skill from the cache. Used by
 * task-worker to inject the skill into the worktree at task spawn time.
 */
export async function readInstalledSkillFiles(
  resolvedSha: string,
  subpath: string,
): Promise<Array<{ relativePath: string; content: Buffer; executable: boolean }>> {
  const baseDir = path.join(cacheDir(), resolvedSha, subpath === "." ? "" : subpath);
  if (!(await pathExists(baseDir))) {
    throw new Error(`cache miss for ${resolvedSha}:${subpath}`);
  }
  const out: Array<{ relativePath: string; content: Buffer; executable: boolean }> = [];
  async function walk(current: string, rel: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(full, relPath);
      } else if (ent.isFile()) {
        const stat = await fs.stat(full);
        const executable = (stat.mode & 0o111) !== 0;
        out.push({ relativePath: relPath, content: await fs.readFile(full), executable });
      }
    }
  }
  await walk(baseDir, "");
  return out;
}
