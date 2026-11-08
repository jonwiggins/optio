/**
 * Sync worker for marketplace-sourced skills (`installed_skills`).
 *
 * Two job types:
 *   - "sync-one"  { id }  → on-demand, fired by POST /api/installed-skills/:id/sync
 *   - "sync-due"  {}      → periodic; finds rows never synced, or whose files at
 *                          their resolved_sha are not in the database
 *
 * For each row, the worker:
 *   1. Resolves `ref` → SHA via `git ls-remote` (cheap, no clone).
 *   2. If the row already carries that SHA and the database holds its files
 *      at that SHA (the `.optio-synced` sentinel row), there is nothing to do.
 *   3. Otherwise shallow-clones into a scratch directory, walks
 *      `<clone>/<subpath>/` once (sizes, the cap, executable bits, SKILL.md
 *      frontmatter, the bytes), and writes the manifest, **every file** and
 *      the sentinel to the database (`installed_skill_files`) in one
 *      transaction.
 *
 * The files live in Postgres, not on a volume: a run spawned on any API
 * instance reads them (`readInstalledSkillFiles`), whichever instance did
 * the sync. The scratch directory (`OPTIO_SKILLS_SCRATCH_DIR`, default
 * `<tmpdir>/optio-skills`) is only ever a clone in flight; the API container's
 * root filesystem is read-only, so it is under /tmp.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Queue, Worker } from "bullmq";
import { parseIntEnv } from "@optio/shared";
import type { InstalledSkillManifest } from "@optio/shared";
import { logger } from "../logger.js";
import { getBullMQOptions } from "../services/redis-config.js";
import { scheduleRepeat } from "../services/repeat-jobs.js";
import { underPollerLease } from "../services/poller-lease.js";
import { db } from "../db/client.js";
import { installedSkillFiles, installedSkills } from "../db/schema.js";
import { and, eq, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import {
  SKILL_SYNC_SENTINEL,
  recordSyncResult,
  type SyncedSkillFile,
} from "../services/installed-skill-service.js";

const execFileP = promisify(execFile);
const bullmqOpts = getBullMQOptions();

/**
 * Every job on the queue retries with backoff: a sync-one whose skill
 * another instance is syncing right now throws `SkillSyncBusyError` and
 * comes back later instead of being dropped (re-adding it from inside the
 * job would be ignored while the job's own id is still taken).
 */
export const SKILL_SYNC_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: "exponential", delay: 5_000 },
} as const;

const skillSyncQueue = new Queue("skill-sync", {
  ...bullmqOpts,
  defaultJobOptions: SKILL_SYNC_JOB_OPTIONS,
});

/** A sync-one found its skill's lease held: retried by BullMQ with backoff. */
export class SkillSyncBusyError extends Error {
  constructor(public readonly skillId: string) {
    super(`skill ${skillId} is being synced by another instance; retrying`);
    this.name = "SkillSyncBusyError";
  }
}

/** One job's work (the worker's processor; exported for tests). */
export async function processSkillSyncJob(job: { name: string; data: unknown }): Promise<void> {
  if (job.name === "sync-due") {
    await underPollerLease("skill-sync", () => syncDue());
  } else if (job.name === "sync-one") {
    const { id } = job.data as { id: string };
    const ran = await underPollerLease(`skill-sync:${id}`, async () => {
      await syncOne(id);
      return true;
    });
    if (ran === null) throw new SkillSyncBusyError(id);
  }
}

function scratchDir(): string {
  return process.env.OPTIO_SKILLS_SCRATCH_DIR ?? path.join(tmpdir(), "optio-skills");
}
const CLONE_TIMEOUT_MS = parseIntEnv("OPTIO_SKILL_CLONE_TIMEOUT_MS", 60_000);
const SYNC_INTERVAL_MS = parseIntEnv("OPTIO_SKILL_SYNC_INTERVAL", 300_000); // 5 min
/** Hard cap per skill — anything bigger is rejected to keep OPTIO_SETUP_FILES sane. */
const MAX_SKILL_BYTES = parseIntEnv("OPTIO_SKILL_MAX_BYTES", 1_048_576); // 1 MiB

export function startSkillSyncWorker() {
  // Periodic sweep for rows that need a sync — one instance at a time; a
  // one-skill sync holds its own lease so two instances never clone the
  // same skill at once (the one that finds it held retries later).
  void scheduleRepeat(skillSyncQueue, "skill-sync.sync-due", SYNC_INTERVAL_MS, {
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  }).catch(() => {});

  // And one pass now: a skill synced to the former cache volume before the
  // upgrade (a commit, no files in the database) is back within seconds.
  skillSyncQueue
    .add("sync-due", {}, { removeOnComplete: true, removeOnFail: { count: 50 } })
    .catch((err) => logger.warn({ err }, "skill sync: could not enqueue the boot pass"));

  const worker = new Worker("skill-sync", (job) => processSkillSyncJob(job), {
    ...bullmqOpts,
    concurrency: 1,
  });

  worker.on("failed", (job, err) => {
    if (err instanceof SkillSyncBusyError) {
      logger.debug({ skillId: err.skillId, attempt: job?.attemptsMade }, err.message);
      return;
    }
    logger.error({ err, jobName: job?.name, jobId: job?.id }, "skill-sync job failed");
  });

  return worker;
}

/**
 * The rows that need a sync: never synced, or synced at a commit whose files
 * are not in the database (a skill synced to the former cache volume before
 * the upgrade, or a write that never landed).
 */
export async function dueSkillIds(): Promise<string[]> {
  const rows = await db
    .select({ id: installedSkills.id })
    .from(installedSkills)
    .where(
      or(
        isNull(installedSkills.resolvedSha),
        eq(installedSkills.lastSyncError, ""),
        and(
          eq(installedSkills.enabled, true),
          isNotNull(installedSkills.resolvedSha),
          notExists(
            db
              .select({ one: sql`1` })
              .from(installedSkillFiles)
              .where(
                and(
                  eq(installedSkillFiles.skillId, installedSkills.id),
                  eq(installedSkillFiles.path, SKILL_SYNC_SENTINEL),
                  eq(installedSkillFiles.resolvedSha, installedSkills.resolvedSha),
                ),
              ),
          ),
        ),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Queues a sync of one skill. The job id is the skill's, so a sync already
 * waiting (a click on Sync during the periodic pass, two instances' passes)
 * absorbs the duplicate rather than running twice. (BullMQ refuses a custom
 * id with one `:`, hence the dash.)
 */
export async function enqueueSkillSync(id: string): Promise<void> {
  await skillSyncQueue.add(
    "sync-one",
    { id },
    { jobId: `sync-one-${id}`, removeOnComplete: true, removeOnFail: true },
  );
}

/** Find all rows that need syncing and enqueue a sync-one for each. */
async function syncDue(): Promise<void> {
  for (const id of await dueSkillIds()) await enqueueSkillSync(id);
}

/** Whether the skill is synced at `sha` in the database (its sentinel row). */
async function filesSynced(skillId: string, sha: string): Promise<boolean> {
  const [row] = await db
    .select({ path: installedSkillFiles.path })
    .from(installedSkillFiles)
    .where(
      and(
        eq(installedSkillFiles.skillId, skillId),
        eq(installedSkillFiles.path, SKILL_SYNC_SENTINEL),
        eq(installedSkillFiles.resolvedSha, sha),
      ),
    )
    .limit(1);
  return !!row;
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

  // What this sync resolves; its result lands only if the row still says so.
  const synced = { ref: row.ref, subpath: row.subpath };
  let clone: string | null = null;
  try {
    const sha = await resolveRefToSha(row.sourceUrl, row.ref);
    if (row.resolvedSha === sha && !row.lastSyncError && (await filesSynced(id, sha))) {
      log.info({ sha }, "already synced at this commit; nothing to do");
      return;
    }

    clone = await cloneIntoScratch(row.sourceUrl, sha, log);
    const subpathDir = await skillDirIn(clone, row.subpath);
    if (!subpathDir) {
      throw new Error(`subpath '${row.subpath}' not found in source@${sha}`);
    }

    // One pass over the directory: manifest, totals, the cap and the bytes.
    const inspected = await readSkillDir(subpathDir, MAX_SKILL_BYTES);
    const { files } = inspected;

    const recorded = await recordSyncResult(
      id,
      {
        ok: true,
        resolvedSha: sha,
        manifest: inspected.manifest,
        hasExecutableFiles: inspected.hasExecutableFiles,
        totalSizeBytes: inspected.totalSizeBytes,
        files,
      },
      synced,
    );
    if (!recorded) {
      log.info({ sha, ref: row.ref }, "skill's ref changed during the sync; result discarded");
      return;
    }
    log.info(
      { sha, fileCount: files.length, bytes: inspected.totalSizeBytes },
      "installed skill synced",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "installed skill sync failed");
    await recordSyncResult(id, { ok: false, error: msg }, synced);
  } finally {
    if (clone) await fs.rm(path.dirname(clone), { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A skill's source URL and ref reach git as arguments, and one that starts
 * with `-` would be read as an option (`--upload-pack=<cmd>` runs a command
 * in the API pod). Neither may, and every call ends its options with `--`.
 */
export function assertSkillSourceArgs(sourceUrl: string, ref: string): void {
  if (!sourceUrl.trim() || sourceUrl.trimStart().startsWith("-")) {
    throw new Error(`invalid skill source URL: ${JSON.stringify(sourceUrl)}`);
  }
  if (ref.trimStart().startsWith("-")) {
    throw new Error(`invalid skill ref: ${JSON.stringify(ref)}`);
  }
}

/**
 * What the API's environment hands the git it runs (`skillGitEnv`): the
 * process basics, the proxy and CA settings a network transport needs, ssh's
 * agent socket, and git's own `GIT_*` knobs. Nothing else — the API's
 * environment also holds its secrets (`OPTIO_ENCRYPTION_KEY`, `DATABASE_URL`,
 * OAuth client secrets), which a child process has no business seeing.
 */
const GIT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
  "XDG_CONFIG_HOME",
  "SSH_AUTH_SOCK",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];

/**
 * The environment git runs with. A member picks the URL, and git runs in
 * the API pod: `file://` would copy whatever repository the pod can read,
 * and `ext::` runs a command, so GIT_ALLOW_PROTOCOL names the transports a
 * skill source may use (it also binds submodules and redirects). Tests clone
 * local fixtures, so they (and OPTIO_SKILL_ALLOW_FILE_SOURCES=1) may use
 * `file` too. Only the allowlisted variables and `GIT_*` pass through — see
 * GIT_ENV_ALLOWLIST.
 */
export function skillGitEnv(): NodeJS.ProcessEnv {
  const allowFile =
    process.env.OPTIO_SKILL_ALLOW_FILE_SOURCES === "1" ||
    process.env.OPTIO_RUNTIME === "fake" ||
    !!process.env.VITEST;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (GIT_ENV_ALLOWLIST.includes(key) || key.startsWith("GIT_")) env[key] = value;
  }
  env.GIT_ALLOW_PROTOCOL = allowFile ? "https:ssh:git:file" : "https:ssh:git";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export async function resolveRefToSha(sourceUrl: string, ref: string): Promise<string> {
  assertSkillSourceArgs(sourceUrl, ref);
  // ls-remote returns "<sha>\trefs/heads/<branch>" lines. We try the requested
  // ref directly and fall back to bare HEAD if the ref doesn't exist.
  const { stdout } = await execFileP(
    "git",
    ["ls-remote", "--", sourceUrl, ref, `refs/tags/${ref}`],
    { timeout: CLONE_TIMEOUT_MS, env: skillGitEnv() },
  );
  const line = stdout.trim().split("\n")[0];
  if (line) {
    const sha = line.split(/\s+/)[0];
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  // Fallback: ls-remote with no ref returns HEAD.
  const head = await execFileP("git", ["ls-remote", "--", sourceUrl, "HEAD"], {
    timeout: CLONE_TIMEOUT_MS,
    env: skillGitEnv(),
  });
  const headSha = head.stdout.trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error(`could not resolve ref '${ref}' for ${sourceUrl}`);
  }
  return headSha;
}

/**
 * A shallow clone of the source at `sha` in a fresh scratch directory.
 * Resolves the clone's path; the caller removes its parent when done.
 */
export async function cloneIntoScratch(
  sourceUrl: string,
  sha: string,
  log: { info: (...args: unknown[]) => void },
): Promise<string> {
  assertSkillSourceArgs(sourceUrl, "");
  await fs.mkdir(scratchDir(), { recursive: true });
  const tmpRoot = await fs.mkdtemp(path.join(scratchDir(), "skill-"));
  const tmpClone = path.join(tmpRoot, "clone");
  try {
    log.info({ sourceUrl, sha }, "shallow-cloning skill source");
    // Clone with depth=1 then check out the exact SHA.
    await execFileP("git", ["clone", "--depth", "1", "--no-tags", "--", sourceUrl, tmpClone], {
      timeout: CLONE_TIMEOUT_MS,
      env: skillGitEnv(),
    });
    // Best-effort: fetch + checkout the exact SHA in case the default ref isn't
    // what we resolved (e.g. tag vs branch).
    try {
      await execFileP("git", ["-C", tmpClone, "fetch", "--depth", "1", "origin", sha], {
        timeout: CLONE_TIMEOUT_MS,
        env: skillGitEnv(),
      });
      await execFileP("git", ["-C", tmpClone, "checkout", "--detach", sha], {
        timeout: CLONE_TIMEOUT_MS,
        env: skillGitEnv(),
      });
    } catch {
      // If fetch-by-sha is unsupported (older servers) the depth-1 clone of
      // the resolved branch should already be at the right SHA.
    }
    // The files, not the history.
    await fs.rm(path.join(tmpClone, ".git"), { recursive: true, force: true });
    return tmpClone;
  } catch (err) {
    // The caller never learns the path of a clone that failed: remove it here.
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export interface SkillDirContents {
  manifest: InstalledSkillManifest;
  hasExecutableFiles: boolean;
  totalSizeBytes: number;
  /** Every file's bytes, paths relative to the skill directory. */
  files: SyncedSkillFile[];
}

/**
 * The skill directory in one pass: every file's size, mode and bytes, the
 * manifest built from them, SKILL.md's frontmatter, and the size cap,
 * checked before a file that would cross it is read. A root-level file named
 * like the sync sentinel is left out (that path is the sync's own).
 */
export async function readSkillDir(
  dir: string,
  maxBytes: number = Number.POSITIVE_INFINITY,
): Promise<SkillDirContents> {
  const files: SyncedSkillFile[] = [];
  const manifestFiles: NonNullable<InstalledSkillManifest["files"]> = [];
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
        if (relPath === SKILL_SYNC_SENTINEL) continue;
        const stat = await fs.stat(full);
        totalSizeBytes += stat.size;
        if (totalSizeBytes > maxBytes) {
          throw new Error(`skill exceeds ${maxBytes} byte cap (at least ${totalSizeBytes} bytes)`);
        }
        const executable = (stat.mode & 0o111) !== 0;
        if (executable) hasExecutableFiles = true;
        manifestFiles.push({ relativePath: relPath, sizeBytes: stat.size, executable });
        files.push({ relativePath: relPath, content: await fs.readFile(full), executable });
      }
    }
  }
  await walk(dir, "");

  let frontmatter: Record<string, unknown> | undefined;
  const skillMd = files.find((f) => f.relativePath.toLowerCase() === "skill.md");
  if (skillMd) frontmatter = parseFrontmatter(skillMd.content.toString("utf8"));

  return {
    manifest: { frontmatter, files: manifestFiles },
    hasExecutableFiles,
    totalSizeBytes,
    files,
  };
}

/**
 * Tiny YAML-frontmatter parser. Handles `key: value` lines (string values)
 * and ignores anything more complex. Good enough for SKILL.md surfaces like
 * `name`, `description`, `version`. Returns undefined when no frontmatter
 * block is present.
 */
export function parseFrontmatter(content: string): Record<string, unknown> | undefined {
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

/**
 * The skill's directory in the clone, after symlinks — null when there is
 * none. A source may carry a symlink, and a subpath through one (`link` →
 * `/home/agent/optio/runs`) would read the API pod's own files into the
 * skill: it must resolve inside the clone.
 */
export async function skillDirIn(clone: string, subpath: string): Promise<string | null> {
  let real: string;
  try {
    real = await fs.realpath(path.join(clone, subpath === "." ? "" : subpath));
  } catch {
    return null;
  }
  const root = await fs.realpath(clone);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`subpath '${subpath}' leads out of the source (a symlink)`);
  }
  return real;
}

/**
 * The materialized files of an installed skill, from the database, for the
 * worker injecting the skill into a run's worktree at spawn time — on any
 * instance, whichever one synced it. With `expectedSha`, files from another
 * commit (a sync in flight) are refused rather than injected half-updated.
 */
export async function readInstalledSkillFiles(
  skillId: string,
  expectedSha?: string | null,
): Promise<Array<{ relativePath: string; content: Buffer; executable: boolean }>> {
  const rows = await db
    .select({
      path: installedSkillFiles.path,
      content: installedSkillFiles.content,
      executable: installedSkillFiles.executable,
      resolvedSha: installedSkillFiles.resolvedSha,
    })
    .from(installedSkillFiles)
    .where(eq(installedSkillFiles.skillId, skillId))
    .orderBy(installedSkillFiles.path);
  if (!rows.some((r) => r.path === SKILL_SYNC_SENTINEL)) {
    throw new Error(`no synced files for installed skill ${skillId}`);
  }
  if (expectedSha) {
    const other = rows.find((r) => r.resolvedSha && r.resolvedSha !== expectedSha);
    if (other) {
      throw new Error(
        `installed skill ${skillId} files are at ${other.resolvedSha}, expected ${expectedSha}`,
      );
    }
  }
  return rows
    .filter((r) => r.path !== SKILL_SYNC_SENTINEL)
    .map((r) => ({
      relativePath: r.path,
      content: Buffer.from(r.content),
      executable: r.executable,
    }));
}
