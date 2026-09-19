import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeClaudeShim } from "../local/hook-server.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "optio-shim-"));
  dirs.push(dir);
  return dir;
}

/** A stand-in `claude` that prints its argv, one per line. */
function fakeClaude(dir: string): string {
  const bin = join(dir, "real");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n', {
    mode: 0o755,
  });
  return bin;
}

function run(shim: string, path: string, args: string[], env: Record<string, string> = {}) {
  return execFileSync(join(shim, "claude"), args, {
    // The shim needs dirname / head / grep from the system dirs.
    env: { PATH: `${path}:/usr/bin:/bin`, ...env },
    encoding: "utf-8",
    timeout: 5000,
  })
    .trim()
    .split("\n");
}

describe("claude shim", () => {
  it("adds the hook settings and finds the real binary past its own dir", () => {
    const root = scratch();
    const real = fakeClaude(root);
    const shim = writeClaudeShim(join(root, "shim"));
    const hooks = join(root, "hooks.json");
    writeFileSync(hooks, "{}");
    expect(
      run(shim, `${shim}:${real}`, ["-p", "hi"], { OPTIO_LOCAL_HOOK_SETTINGS: hooks }),
    ).toEqual(["--settings", hooks, "-p", "hi"]);
    expect(run(shim, `${shim}:${real}`, ["--settings", "mine", "-p"])).toEqual([
      "--settings",
      "mine",
      "-p",
    ]);
  });

  it("skips another daemon's shim on PATH instead of exec-ing it in a loop", () => {
    const root = scratch();
    const real = fakeClaude(root);
    const inner = writeClaudeShim(join(root, "inner"));
    const outer = writeClaudeShim(join(root, "outer"));
    // A daemon started inside an Optio terminal: its own shim first, the
    // outer daemon's shim next, the real binary last.
    expect(run(inner, `${inner}:${outer}:${real}`, ["-p"])).toEqual(["-p"]);
  });
});
