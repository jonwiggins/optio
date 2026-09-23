import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeConfigDir,
  findClaudeTranscript,
  readSessionTranscript,
  transcriptCwd,
} from "../local/transcript-backfill.js";

const SESSION = "c1545b8e-d116-4761-8921-38509a508395";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A Claude config dir holding one session transcript under a project folder. */
function claudeDir(lines: unknown[], opts: { project?: string; session?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "optio-claude-"));
  dirs.push(dir);
  const project = join(dir, "projects", opts.project ?? "-home-dev-optio");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(dir, "projects", "-home-dev-other"), { recursive: true });
  writeFileSync(
    join(project, `${opts.session ?? SESSION}.jsonl`),
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );
  return dir;
}

let n = 0;
const line = (type: string, content: unknown, cwd = "/home/dev/optio") => ({
  type,
  uuid: `u-${++n}`,
  timestamp: "2026-09-20T03:46:20.000Z",
  cwd,
  sessionId: SESSION,
  message: { role: type, content },
});

const conversation = (cwd = "/home/dev/optio") => [
  { type: "file-history-snapshot", messageId: "m0", snapshot: {} },
  line("user", "Summarize PR #607", cwd),
  line(
    "assistant",
    [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "gh pr view 607" } }],
    cwd,
  ),
  line("user", [{ type: "tool_result", tool_use_id: "t1", content: "title: test PR" }], cwd),
  line("assistant", [{ type: "text", text: "Do not merge — it's a test." }], cwd),
];

describe("claudeConfigDir", () => {
  it("honors CLAUDE_CONFIG_DIR, else ~/.claude", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/opt/claude" })).toBe("/opt/claude");
    expect(claudeConfigDir({})).toMatch(/\.claude$/);
  });
});

describe("findClaudeTranscript", () => {
  it("finds a session in whichever project folder holds it", () => {
    const dir = claudeDir(conversation(), { project: "-Users-someone-repos-x" });
    expect(findClaudeTranscript(SESSION, dir)).toBe(
      join(dir, "projects", "-Users-someone-repos-x", `${SESSION}.jsonl`),
    );
  });

  it("returns null for an unknown session or a missing config dir", () => {
    const dir = claudeDir(conversation());
    expect(findClaudeTranscript("0e9d2a4c-7c1d-4e7a-9b1b-6f1f6c8f0a11", dir)).toBeNull();
    expect(findClaudeTranscript(SESSION, join(dir, "nope"))).toBeNull();
  });

  it("only takes a session id, never a path", () => {
    const dir = claudeDir(conversation());
    expect(findClaudeTranscript(`../${SESSION}`, dir)).toBeNull();
    expect(findClaudeTranscript("../../etc/passwd", dir)).toBeNull();
    expect(findClaudeTranscript("", dir)).toBeNull();
  });
});

describe("transcriptCwd", () => {
  it("is the first working dir the transcript records, past lines without one", () => {
    const dir = claudeDir(["not json", ...conversation("/home/dev/optio/apps")]);
    expect(transcriptCwd(findClaudeTranscript(SESSION, dir)!)).toBe("/home/dev/optio/apps");
  });

  it("is null when no line names one", () => {
    const dir = claudeDir([{ type: "summary", summary: "x" }]);
    expect(transcriptCwd(findClaudeTranscript(SESSION, dir)!)).toBeNull();
  });
});

describe("readSessionTranscript", () => {
  it("distills the whole conversation, numbered from 1", () => {
    const configDir = claudeDir(conversation());
    const { entries, error } = readSessionTranscript({
      agent: "claude-code",
      sessionId: SESSION,
      allowedDirs: ["/home/dev/optio"],
      configDir,
    });
    expect(error).toBeUndefined();
    expect(entries.map((e) => [e.seq, e.role, e.kind])).toEqual([
      [1, "user", "text"],
      [2, "assistant", "tool_use"],
      [3, "tool", "tool_result"],
      [4, "assistant", "text"],
    ]);
    expect(entries[3]!.text).toBe("Do not merge — it's a test.");
  });

  it("accepts a session that ran below an allowlisted dir", () => {
    const configDir = claudeDir(conversation("/home/dev/optio/apps/api"));
    const { entries } = readSessionTranscript({
      agent: "claude-code",
      sessionId: SESSION,
      allowedDirs: ["/home/dev/optio/"],
      configDir,
    });
    expect(entries).toHaveLength(4);
  });

  it("refuses a session that ran outside the allowlisted dirs", () => {
    const configDir = claudeDir(conversation("/home/dev/optio-private"));
    const result = readSessionTranscript({
      agent: "claude-code",
      sessionId: SESSION,
      allowedDirs: ["/home/dev/optio"],
      configDir,
    });
    expect(result.entries).toEqual([]);
    expect(result.error).toMatch(/outside/);
  });

  it("says why when there is nothing to read", () => {
    const configDir = claudeDir(conversation());
    expect(
      readSessionTranscript({
        agent: "claude-code",
        sessionId: "0e9d2a4c-7c1d-4e7a-9b1b-6f1f6c8f0a11",
        allowedDirs: ["/home/dev/optio"],
        configDir,
      }).error,
    ).toMatch(/No transcript/);
    expect(
      readSessionTranscript({
        agent: "codex",
        sessionId: SESSION,
        allowedDirs: ["/home/dev/optio"],
        configDir,
      }).error,
    ).toMatch(/codex/);
  });
});
