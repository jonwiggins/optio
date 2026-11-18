import { describe, expect, it } from "vitest";
import { formatSkillSyncError, redactSkillSource } from "./skill-sync-error.js";
const source = "https://github.com/example/skills.git";
describe("marketplace sync diagnostics", () => {
  it("explains authentication failures and preserves stderr instead of the command", () => {
    const stderr =
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
    const message = formatSkillSyncError(
      Object.assign(new Error("Command failed: git ls-remote"), { stderr }),
      "resolve the source ref",
      source,
    );
    expect(message).toContain("Could not resolve the source ref.");
    expect(message).toContain("Git authentication failed.");
    expect(message).toContain(stderr);
    expect(message).not.toContain("Command failed:");
  });
  it.each([
    "fatal: Authentication failed",
    "Permission denied (publickey).",
    "remote: Invalid username or token.",
  ])("recognizes %s", (stderr) => {
    expect(formatSkillSyncError({ stderr }, "clone the source repository", source)).toContain(
      "Git authentication failed",
    );
  });
  it("does not claim a hidden repository is definitely private", () => {
    const message = formatSkillSyncError(
      { stderr: "fatal: repository not found" },
      "clone the source repository",
      source,
    );
    expect(message).toContain("Check the repository URL and access permissions");
    expect(message).toContain("may appear missing");
  });
  it("explains timeouts and retains other errors", () => {
    expect(formatSkillSyncError({ killed: true }, "clone the source repository", source)).toContain(
      "Git timed out",
    );
    expect(formatSkillSyncError({ code: "ETIMEDOUT" }, "resolve the source ref", source)).toContain(
      "Git timed out",
    );
    expect(
      formatSkillSyncError(
        new Error("fatal: unable to resolve host"),
        "resolve the source ref",
        source,
      ),
    ).toContain("fatal: unable to resolve host");
    expect(formatSkillSyncError("disk full", "read the skill files", source)).toContain(
      "disk full",
    );
  });
  it("redacts URL credentials and separately echoed encoded secrets", () => {
    const url = "https://alice:p%40ssword@example.com/repo.git?token=my-token";
    const message = formatSkillSyncError(
      new Error(`Command failed: git clone ${url}\np@ssword p%40ssword my-token`),
      "clone the source repository",
      url,
    );
    for (const secret of ["alice", "p@ssword", "p%40ssword", "my-token"])
      expect(message).not.toContain(secret);
    expect(redactSkillSource(url)).toBe("https://[redacted]@example.com/repo.git?token=[redacted]");
  });
  it("bounds output and strips terminal control characters", () => {
    const message = formatSkillSyncError(
      new Error("\u001b" + "x".repeat(5000)),
      "read the skill files",
      source,
    );
    expect(message).toContain("[truncated]");
    expect(message).not.toContain("\u001b");
    expect(message.length).toBeLessThan(4200);
  });
});
