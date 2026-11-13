/**
 * Marketplace skills synced into the database: the sync worker clones a
 * source (a local git repository here), writes every file to
 * `installed_skill_files` with the row's manifest, and the spawn-time
 * reader finds them with no filesystem in common — the way an instance
 * that never ran the sync does. A re-sync at the same commit is a no-op; a
 * new commit replaces the set; deleting the skill cascades.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { installedSkillFiles, installedSkills } from "../db/schema.js";

vi.mock("bullmq", () => ({
  Queue: class {
    add() {
      return Promise.resolve();
    }
  },
  Worker: class {
    on() {}
    close() {
      return Promise.resolve();
    }
  },
}));

// A hook that runs just before a sync records its result: the moment a
// PATCH can land while the sync of the old ref is in flight.
const beforeRecord = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>) }));
vi.mock("../services/installed-skill-service.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/installed-skill-service.js")>();
  return {
    ...real,
    recordSyncResult: async (...args: Parameters<typeof real.recordSyncResult>) => {
      const hook = beforeRecord.hook;
      beforeRecord.hook = null;
      if (hook) await hook();
      return real.recordSyncResult(...args);
    },
  };
});

const run = promisify(execFile);
let root: string;
let source: string;

async function git(args: string[], cwd = source) {
  await run("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "optio-skill-int-"));
  process.env.OPTIO_SKILLS_SCRATCH_DIR = path.join(root, "scratch");
  source = path.join(root, "source");
  await fs.mkdir(path.join(source, "skills", "greet", "scripts"), { recursive: true });
  await fs.writeFile(
    path.join(source, "skills", "greet", "SKILL.md"),
    "---\nname: greet\ndescription: says hi\n---\n\nSay hi.\n",
  );
  const script = path.join(source, "skills", "greet", "scripts", "hi.sh");
  await fs.writeFile(script, "#!/bin/sh\necho hi\n");
  await fs.chmod(script, 0o755);
  // A skill directory with no files of its own (its one file is the
  // sentinel's name, which the sync leaves out).
  await fs.mkdir(path.join(source, "skills", "empty"), { recursive: true });
  await fs.writeFile(path.join(source, "skills", "empty", ".optio-synced"), "not ours\n");
  await git(["init", "-q", "-b", "main"]);
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "greet"]);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function insertSkill(subpath = "skills/greet") {
  const [row] = await db
    .insert(installedSkills)
    .values({
      name: `greet-${Math.random().toString(36).slice(2, 8)}`,
      sourceUrl: `file://${source}`,
      ref: "main",
      subpath,
      scope: "global",
    })
    .returning();
  return row;
}

describe("skill sync into the database", () => {
  it("writes the files and the manifest; the reader finds them without a filesystem", async () => {
    const { syncOne, readInstalledSkillFiles } = await import("./skill-sync-worker.js");
    const skill = await insertSkill();
    await syncOne(skill.id);

    const [after] = await db.select().from(installedSkills).where(eq(installedSkills.id, skill.id));
    expect(after.lastSyncError).toBeNull();
    expect(after.resolvedSha).toMatch(/^[0-9a-f]{40}$/);
    expect(after.hasExecutableFiles).toBe(true);
    expect((after.cachedManifest as { frontmatter?: { name?: string } }).frontmatter?.name).toBe(
      "greet",
    );

    const files = await readInstalledSkillFiles(skill.id, after.resolvedSha);
    expect(files.map((f) => f.relativePath)).toEqual(["SKILL.md", "scripts/hi.sh"]);
    expect(files[0].content.toString()).toContain("Say hi.");
    expect(files[1].executable).toBe(true);
    const rows = await db
      .select({ sha: installedSkillFiles.resolvedSha })
      .from(installedSkillFiles)
      .where(eq(installedSkillFiles.skillId, skill.id));
    expect(rows.every((r) => r.sha === after.resolvedSha)).toBe(true);

    // The scratch clone is gone once the files are in the database.
    const scratch = await fs.readdir(process.env.OPTIO_SKILLS_SCRATCH_DIR!).catch(() => []);
    expect(scratch).toEqual([]);

    // Files at another commit are refused rather than injected half-updated.
    await expect(readInstalledSkillFiles(skill.id, "0".repeat(40))).rejects.toThrow(/expected/);
    // A skill that was never synced has nothing to inject.
    const bare = await insertSkill();
    await expect(readInstalledSkillFiles(bare.id)).rejects.toThrow(/no synced files/);
  });

  it("is a no-op at the same commit and replaces the set at a new one", async () => {
    const { syncOne, readInstalledSkillFiles } = await import("./skill-sync-worker.js");
    const skill = await insertSkill();
    await syncOne(skill.id);
    const [first] = await db.select().from(installedSkills).where(eq(installedSkills.id, skill.id));
    await syncOne(skill.id);
    const [second] = await db
      .select()
      .from(installedSkills)
      .where(eq(installedSkills.id, skill.id));
    expect(second.lastSyncedAt?.getTime()).toBe(first.lastSyncedAt?.getTime());

    await fs.writeFile(path.join(source, "skills", "greet", "extra.md"), "more\n");
    await fs.rm(path.join(source, "skills", "greet", "scripts"), { recursive: true });
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "change"]);
    await syncOne(skill.id);
    const [third] = await db.select().from(installedSkills).where(eq(installedSkills.id, skill.id));
    expect(third.resolvedSha).not.toBe(first.resolvedSha);
    const files = await readInstalledSkillFiles(skill.id, third.resolvedSha);
    expect(files.map((f) => f.relativePath)).toEqual(["SKILL.md", "extra.md"]);
  });

  it("finds a skill synced before the upgrade (a commit, no files in the database) due again", async () => {
    const { syncOne, dueSkillIds } = await import("./skill-sync-worker.js");
    const synced = await insertSkill();
    await syncOne(synced.id);
    const legacy = await insertSkill();
    // What a row synced to the former cache volume looks like after the upgrade.
    await db
      .update(installedSkills)
      .set({ resolvedSha: "a".repeat(40), lastSyncedAt: new Date() })
      .where(eq(installedSkills.id, legacy.id));

    let due = await dueSkillIds();
    expect(due).toContain(legacy.id);
    expect(due).not.toContain(synced.id);

    await syncOne(legacy.id);
    due = await dueSkillIds();
    expect(due).not.toContain(legacy.id);
  });

  it("a skill with no files is synced (the sentinel), read as empty, and not due again", async () => {
    const { syncOne, dueSkillIds, readInstalledSkillFiles } =
      await import("./skill-sync-worker.js");
    const skill = await insertSkill("skills/empty");
    await syncOne(skill.id);
    const [first] = await db.select().from(installedSkills).where(eq(installedSkills.id, skill.id));
    expect(first.lastSyncError).toBeNull();
    expect(first.resolvedSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await readInstalledSkillFiles(skill.id, first.resolvedSha)).toEqual([]);
    expect(await dueSkillIds()).not.toContain(skill.id);
    await syncOne(skill.id);
    const [second] = await db
      .select()
      .from(installedSkills)
      .where(eq(installedSkills.id, skill.id));
    expect(second.lastSyncedAt?.getTime()).toBe(first.lastSyncedAt?.getTime());
  });

  it("discards a sync of the old ref when the ref changes meanwhile; the next sync-due takes the new one", async () => {
    const { syncOne, dueSkillIds, readInstalledSkillFiles } =
      await import("./skill-sync-worker.js");
    const { updateInstalledSkill } = await import("../services/installed-skill-service.js");
    // A branch whose skill differs from main's.
    await git(["checkout", "-q", "-b", "next"]);
    await fs.writeFile(path.join(source, "skills", "greet", "next.md"), "only on next\n");
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "next"]);
    await git(["checkout", "-q", "main"]);

    const skill = await insertSkill();
    // The sync of main is cloned and read; before it records, the ref moves.
    beforeRecord.hook = async () => {
      await updateInstalledSkill(skill.id, { ref: "next" });
    };
    await syncOne(skill.id);

    const [after] = await db.select().from(installedSkills).where(eq(installedSkills.id, skill.id));
    expect(after.ref).toBe("next");
    expect(after.resolvedSha).toBeNull(); // nothing of main's sync landed
    const files = await db
      .select()
      .from(installedSkillFiles)
      .where(eq(installedSkillFiles.skillId, skill.id));
    expect(files).toEqual([]);
    expect(await dueSkillIds()).toContain(skill.id);

    // The periodic pass syncs the new ref.
    await syncOne(skill.id);
    const [synced] = await db
      .select()
      .from(installedSkills)
      .where(eq(installedSkills.id, skill.id));
    expect(synced.resolvedSha).toMatch(/^[0-9a-f]{40}$/);
    const read = await readInstalledSkillFiles(skill.id, synced.resolvedSha);
    expect(read.map((f) => f.relativePath)).toContain("next.md");
    expect(await dueSkillIds()).not.toContain(skill.id);
  });

  it("two syncs of one skill at once both succeed (the writes upsert)", async () => {
    const { syncOne, readInstalledSkillFiles } = await import("./skill-sync-worker.js");
    const skill = await insertSkill();
    await Promise.all([syncOne(skill.id), syncOne(skill.id), syncOne(skill.id)]);
    const [after] = await db.select().from(installedSkills).where(eq(installedSkills.id, skill.id));
    expect(after.lastSyncError).toBeNull();
    const files = await readInstalledSkillFiles(skill.id, after.resolvedSha);
    expect(files.map((f) => f.relativePath)).toContain("SKILL.md");
  });

  it("a clone that fails leaves nothing in the scratch directory", async () => {
    const { cloneIntoScratch } = await import("./skill-sync-worker.js");
    const notARepo = path.join(root, "not-a-repo");
    await fs.mkdir(notARepo, { recursive: true });
    await expect(
      cloneIntoScratch(`file://${notARepo}`, "0".repeat(40), { info: () => {} }),
    ).rejects.toThrow();
    const scratch = await fs.readdir(process.env.OPTIO_SKILLS_SCRATCH_DIR!).catch(() => []);
    expect(scratch).toEqual([]);
  });

  it("persists contextual Git diagnostics and clears them after a successful retry", async () => {
    const { syncOne } = await import("./skill-sync-worker.js");
    const skill = await insertSkill();
    await db
      .update(installedSkills)
      .set({ sourceUrl: `file://${root}/missing-source.git` })
      .where(eq(installedSkills.id, skill.id));
    await syncOne(skill.id);
    const [failed] = await db
      .select()
      .from(installedSkills)
      .where(eq(installedSkills.id, skill.id));
    expect(failed.lastSyncError).toContain("Could not resolve the source ref.");
    expect(failed.lastSyncError).toContain("fatal:");
    expect(failed.lastSyncError).not.toContain("Command failed:");
    expect(failed.lastSyncedAt).not.toBeNull();
    await db
      .update(installedSkills)
      .set({ sourceUrl: `file://${source}` })
      .where(eq(installedSkills.id, skill.id));
    await syncOne(skill.id);
    const [recovered] = await db
      .select()
      .from(installedSkills)
      .where(eq(installedSkills.id, skill.id));
    expect(recovered.lastSyncError).toBeNull();
    expect(recovered.resolvedSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("records a missing subpath as the sync error and keeps no files; deleting the skill cascades", async () => {
    const { syncOne } = await import("./skill-sync-worker.js");
    const skill = await insertSkill("skills/nope");
    await syncOne(skill.id);
    const [after] = await db.select().from(installedSkills).where(eq(installedSkills.id, skill.id));
    expect(after.lastSyncError).toMatch(/subpath 'skills\/nope' not found/);
    expect(after.resolvedSha).toBeNull();

    const good = await insertSkill();
    await syncOne(good.id);
    await db.delete(installedSkills).where(eq(installedSkills.id, good.id));
    const left = await db
      .select()
      .from(installedSkillFiles)
      .where(eq(installedSkillFiles.skillId, good.id));
    expect(left).toEqual([]);
  });
});
