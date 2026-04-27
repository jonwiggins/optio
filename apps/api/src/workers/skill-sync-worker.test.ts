import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

// Override the cache dir before importing the worker so readInstalledSkillFiles
// looks at our scratch dir, not /opt/optio/skills-cache.
const TEST_CACHE = path.join(tmpdir(), `optio-skill-test-${Date.now()}`);
process.env.OPTIO_SKILLS_CACHE_DIR = TEST_CACHE;

// Stub BullMQ so importing the module doesn't try to talk to Redis.
import { vi } from "vitest";
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
  getBullMQConnectionOptions: () => ({}),
}));

import { readInstalledSkillFiles } from "./skill-sync-worker.js";

describe("readInstalledSkillFiles", () => {
  const sha = "abcdef".repeat(7); // fake 42-char string is fine for test cache lookup
  const baseDir = path.join(TEST_CACHE, sha);

  beforeAll(async () => {
    await fs.mkdir(path.join(baseDir, "scripts"), { recursive: true });
    await fs.writeFile(path.join(baseDir, "SKILL.md"), "---\nname: test\n---\n\nbody", "utf8");
    await fs.writeFile(path.join(baseDir, "reference.md"), "ref", "utf8");
    const helper = path.join(baseDir, "scripts", "helper.sh");
    await fs.writeFile(helper, "#!/bin/sh\necho hi", "utf8");
    await fs.chmod(helper, 0o755);
  });

  afterAll(async () => {
    await fs.rm(TEST_CACHE, { recursive: true, force: true });
  });

  it("walks the subpath and returns each file with executable flag and bytes", async () => {
    const files = await readInstalledSkillFiles(sha, ".");
    const byPath = Object.fromEntries(files.map((f) => [f.relativePath, f]));
    expect(Object.keys(byPath).sort()).toEqual(["SKILL.md", "reference.md", "scripts/helper.sh"]);
    expect(byPath["scripts/helper.sh"].executable).toBe(true);
    expect(byPath["SKILL.md"].executable).toBe(false);
    expect(byPath["SKILL.md"].content.toString("utf8")).toMatch(/^---/);
  });

  it("respects subpath", async () => {
    const files = await readInstalledSkillFiles(sha, "scripts");
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe("helper.sh");
  });

  it("throws on cache miss", async () => {
    await expect(
      readInstalledSkillFiles("0000000000000000000000000000000000000000", "."),
    ).rejects.toThrow(/cache miss/);
  });
});
