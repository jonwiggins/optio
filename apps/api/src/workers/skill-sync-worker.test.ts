import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

// Stub BullMQ so importing the module doesn't try to talk to Redis.
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
vi.mock("../services/redis-config.js", () => ({
  getBullMQConnectionOptions: () => ({ url: "redis://localhost:6379", maxRetriesPerRequest: null }),
  getBullMQOptions: () => ({
    connection: { url: "redis://localhost:6379", maxRetriesPerRequest: null },
    prefix: "bull",
  }),
}));
vi.mock("../db/client.js", () => ({ db: {} }));

const leaseFree = { value: true };
vi.mock("../services/poller-lease.js", () => ({
  underPollerLease: async (_name: string, fn: () => Promise<unknown>) =>
    leaseFree.value ? fn() : null,
}));

import {
  skillGitEnv,
  SKILL_SYNC_JOB_OPTIONS,
  SkillSyncBusyError,
  assertSkillSourceArgs,
  cloneIntoScratch,
  parseFrontmatter,
  processSkillSyncJob,
  readSkillDir,
  resolveRefToSha,
  skillDirIn,
} from "./skill-sync-worker.js";

describe("a skill source that looks like an option", () => {
  const dir = path.join(tmpdir(), `optio-skill-argv-${process.pid}-${Date.now()}`);
  const marker = path.join(dir, "pwned");

  beforeAll(() => fs.mkdir(dir, { recursive: true }));
  afterAll(() => fs.rm(dir, { recursive: true, force: true }));

  it("is refused before it reaches git, so --upload-pack never runs a command", async () => {
    const url = `--upload-pack=touch ${marker};false`;
    await expect(resolveRefToSha(url, ".")).rejects.toThrow(/invalid skill source URL/);
    await expect(resolveRefToSha(url, "HEAD")).rejects.toThrow(/invalid skill source URL/);
    await expect(cloneIntoScratch(url, "0".repeat(40), { info: () => {} })).rejects.toThrow(
      /invalid skill source URL/,
    );
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never reads a subpath that leads out of the clone through a symlink", async () => {
    const clone = path.join(dir, "clone");
    const outside = path.join(dir, "api-pod-home");
    await fs.mkdir(path.join(clone, "skills", "real"), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "credentials.json"), "secret");
    await fs.symlink(outside, path.join(clone, "link"));
    await fs.symlink(path.join(clone, "skills"), path.join(clone, "inner"));

    await expect(skillDirIn(clone, "link")).rejects.toThrow(/leads out of the source/);
    await expect(skillDirIn(clone, "link/.")).rejects.toThrow(/leads out of the source/);
    expect(await skillDirIn(clone, "skills/real")).toBe(
      await fs.realpath(path.join(clone, "skills", "real")),
    );
    // A link that stays inside the clone is fine; a missing subpath is null.
    expect(await skillDirIn(clone, "inner/real")).toBe(
      await fs.realpath(path.join(clone, "skills", "real")),
    );
    expect(await skillDirIn(clone, "nope")).toBeNull();
  });

  it("refuses a ref that starts with -, and takes ordinary ones", () => {
    expect(() => assertSkillSourceArgs("https://example.com/s.git", "--output=x")).toThrow(
      /invalid skill ref/,
    );
    expect(() => assertSkillSourceArgs(" -c", "main")).toThrow(/invalid skill source URL/);
    expect(() => assertSkillSourceArgs("https://example.com/s.git", "v1.2-rc")).not.toThrow();
    expect(() => assertSkillSourceArgs("file:///tmp/skills", "")).not.toThrow();
  });

  it("keeps git to network transports outside tests", () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("OPTIO_RUNTIME", "kubernetes");
    vi.stubEnv("OPTIO_SKILL_ALLOW_FILE_SOURCES", "");
    try {
      expect(skillGitEnv().GIT_ALLOW_PROTOCOL).toBe("https:ssh:git");
      vi.stubEnv("OPTIO_SKILL_ALLOW_FILE_SOURCES", "1");
      expect(skillGitEnv().GIT_ALLOW_PROTOCOL).toBe("https:ssh:git:file");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("hands git only what it needs, never the API's secrets", () => {
    vi.stubEnv("OPTIO_ENCRYPTION_KEY", "0123456789abcdef");
    vi.stubEnv("OPTIO_ENCRYPTION_KEY_PREVIOUS", "fedcba9876543210");
    vi.stubEnv("DATABASE_URL", "postgres://u:p@db/optio");
    vi.stubEnv("REDIS_URL", "redis://redis");
    vi.stubEnv("GITHUB_OAUTH_CLIENT_SECRET", "oauth-secret");
    vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
    vi.stubEnv("HTTPS_PROXY", "http://proxy:3128");
    vi.stubEnv("SSL_CERT_FILE", "/etc/ssl/private-ca.pem");
    vi.stubEnv("GIT_SSL_CAINFO", "/etc/ssl/git-ca.pem");
    try {
      const env = skillGitEnv();
      for (const secret of [
        "OPTIO_ENCRYPTION_KEY",
        "OPTIO_ENCRYPTION_KEY_PREVIOUS",
        "DATABASE_URL",
        "REDIS_URL",
        "GITHUB_OAUTH_CLIENT_SECRET",
        "GITHUB_TOKEN",
      ]) {
        expect(env, secret).not.toHaveProperty(secret);
      }
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HTTPS_PROXY).toBe("http://proxy:3128");
      expect(env.SSL_CERT_FILE).toBe("/etc/ssl/private-ca.pem");
      expect(env.GIT_SSL_CAINFO).toBe("/etc/ssl/git-ca.pem");
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(env.GIT_ALLOW_PROTOCOL).toBe("https:ssh:git:file");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("sync-one under another instance's lease", () => {
  it("throws a retryable busy error instead of dropping the sync", async () => {
    leaseFree.value = false;
    try {
      await expect(
        processSkillSyncJob({ name: "sync-one", data: { id: "skill-1" } }),
      ).rejects.toBeInstanceOf(SkillSyncBusyError);
    } finally {
      leaseFree.value = true;
    }
  });

  it("every job on the queue retries with exponential backoff", () => {
    expect(SKILL_SYNC_JOB_OPTIONS.attempts).toBeGreaterThan(1);
    expect(SKILL_SYNC_JOB_OPTIONS.backoff.type).toBe("exponential");
  });
});

describe("a cloned skill directory", () => {
  const baseDir = path.join(tmpdir(), `optio-skill-test-${Date.now()}`);

  beforeAll(async () => {
    await fs.mkdir(path.join(baseDir, "scripts"), { recursive: true });
    await fs.writeFile(path.join(baseDir, "SKILL.md"), "---\nname: test\n---\n\nbody", "utf8");
    await fs.writeFile(path.join(baseDir, "reference.md"), "ref", "utf8");
    const helper = path.join(baseDir, "scripts", "helper.sh");
    await fs.writeFile(helper, "#!/bin/sh\necho hi", "utf8");
    await fs.chmod(helper, 0o755);
  });

  afterAll(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("reads every file once: bytes, executable flag, manifest, frontmatter", async () => {
    const read = await readSkillDir(baseDir);
    const byPath = Object.fromEntries(read.files.map((f) => [f.relativePath, f]));
    expect(Object.keys(byPath).sort()).toEqual(["SKILL.md", "reference.md", "scripts/helper.sh"]);
    expect(byPath["scripts/helper.sh"].executable).toBe(true);
    expect(byPath["SKILL.md"].executable).toBe(false);
    expect(byPath["SKILL.md"].content.toString("utf8")).toMatch(/^---/);
    expect(read.hasExecutableFiles).toBe(true);
    expect(read.totalSizeBytes).toBe(read.files.reduce((n, f) => n + f.content.length, 0));
    expect(read.manifest.frontmatter).toEqual({ name: "test" });
    expect(read.manifest.files?.map((f) => f.relativePath).sort()).toEqual([
      "SKILL.md",
      "reference.md",
      "scripts/helper.sh",
    ]);
  });

  it("reads a subpath on its own", async () => {
    const read = await readSkillDir(path.join(baseDir, "scripts"));
    expect(read.files.map((f) => f.relativePath)).toEqual(["helper.sh"]);
    expect(read.manifest.frontmatter).toBeUndefined();
  });

  it("stops at the size cap", async () => {
    await expect(readSkillDir(baseDir, 5)).rejects.toThrow(/exceeds 5 byte cap/);
  });

  it("leaves out a root file named like the sync sentinel, and reads an empty skill", async () => {
    const dir = path.join(baseDir, "..", `optio-skill-sentinel-${Date.now()}`);
    await fs.mkdir(path.join(dir, "nested"), { recursive: true });
    await fs.writeFile(path.join(dir, ".optio-synced"), "not ours");
    await fs.writeFile(path.join(dir, "nested", ".optio-synced"), "fine here");
    try {
      const read = await readSkillDir(dir);
      expect(read.files.map((f) => f.relativePath)).toEqual(["nested/.optio-synced"]);
      await fs.rm(path.join(dir, "nested"), { recursive: true });
      await fs.rm(path.join(dir, ".optio-synced"));
      const empty = await readSkillDir(dir);
      expect(empty.files).toEqual([]);
      expect(empty.totalSizeBytes).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseFrontmatter", () => {
  it("reads key: value lines and strips one layer of quotes", () => {
    expect(parseFrontmatter("---\nname: \"a b\"\nversion: '1'\n---\nbody")).toEqual({
      name: "a b",
      version: "1",
    });
  });
  it("is undefined without a block", () => {
    expect(parseFrontmatter("# no frontmatter")).toBeUndefined();
  });
});
