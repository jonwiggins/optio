import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = join(import.meta.dirname, "../../../../scripts/check-migration-prefixes.sh");

function run(dir: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`bash "${SCRIPT}" "${dir}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("check-migration-prefixes.sh", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "migration-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes when no duplicate prefixes exist", () => {
    writeFileSync(join(tmpDir, "0001_init.sql"), "SELECT 1;");
    writeFileSync(join(tmpDir, "0002_add_users.sql"), "SELECT 1;");
    writeFileSync(join(tmpDir, "0003_add_repos.sql"), "SELECT 1;");

    const result = run(tmpDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no new duplicates found");
  });

  it("fails when a new duplicate prefix is found", () => {
    writeFileSync(join(tmpDir, "0001_init.sql"), "SELECT 1;");
    writeFileSync(join(tmpDir, "0001_other.sql"), "SELECT 1;");

    const result = run(tmpDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Duplicate migration prefix '0001'");
    expect(result.stderr).toContain("0001_init.sql");
    expect(result.stderr).toContain("0001_other.sql");
  });

  it("allows historically duplicated prefixes from the allowlist", () => {
    // 0016, 0018, 0019, 0026, 0039, 0042 are allowlisted
    writeFileSync(join(tmpDir, "0016_add_query_indexes.sql"), "SELECT 1;");
    writeFileSync(join(tmpDir, "0016_notification_webhooks.sql"), "SELECT 1;");
    writeFileSync(join(tmpDir, "0039_add_git_platform.sql"), "SELECT 1;");
    writeFileSync(join(tmpDir, "0039_cautious_mode.sql"), "SELECT 1;");

    const result = run(tmpDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no new duplicates found");
  });

  it("fails for new duplicates even when allowlisted ones exist", () => {
    writeFileSync(join(tmpDir, "0016_a.sql"), "SELECT 1;");
    writeFileSync(join(tmpDir, "0016_b.sql"), "SELECT 1;"); // allowlisted
    writeFileSync(join(tmpDir, "0050_foo.sql"), "SELECT 1;");
    writeFileSync(join(tmpDir, "0050_bar.sql"), "SELECT 1;"); // NOT allowlisted

    const result = run(tmpDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Duplicate migration prefix '0050'");
  });

  it("passes with timestamp-prefixed migrations (no collisions)", () => {
    writeFileSync(join(tmpDir, "1775609000_add_foo.sql"), "SELECT 1;");
    writeFileSync(join(tmpDir, "1775609100_add_bar.sql"), "SELECT 1;");
    writeFileSync(join(tmpDir, "0001_legacy.sql"), "SELECT 1;");

    const result = run(tmpDir);
    expect(result.status).toBe(0);
  });

  it("fails when the migrations directory does not exist", () => {
    const result = run("/nonexistent/path");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("migrations directory not found");
  });

  it("passes on the actual migrations directory (historical dups allowlisted)", () => {
    const realDir = join(import.meta.dirname, "migrations");
    const result = run(realDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no new duplicates found");
  });

  it("handles empty directory gracefully", () => {
    const result = run(tmpDir);
    expect(result.status).toBe(0);
  });
});
