#!/usr/bin/env node
// Run independent check commands at once, one log file each, so their output never interleaves.
// Usage: node scripts/run-parallel.mjs '<json array of [command, ...args]>'
// Prints one line per command as it finishes; on failure, the tail of each failed command's log.
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TAIL_LINES = 60;

export async function runParallel(commands, { cwd = process.cwd(), logDir } = {}) {
  // Inside .git, never the working tree: check:push refuses a run that changes files.
  const dir =
    logDir ??
    resolve(
      cwd,
      execFileSync("git", ["rev-parse", "--git-path", "optio-check-logs"], {
        cwd,
        encoding: "utf8",
      }).trim(),
    );
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const results = await Promise.all(
    commands.map(([command, ...args], i) => {
      const label = [command, ...args].join(" ");
      const logPath = join(dir, `${i + 1}-${label.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.log`);
      const log = createWriteStream(logPath);
      const begin = Date.now();
      return new Promise((done) => {
        const child = spawn(command, args, {
          cwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.pipe(log, { end: false });
        child.stderr.pipe(log, { end: false });
        let finished = false;
        const finish = (code) => {
          if (finished) return; // a spawn error can be followed by "close"
          finished = true;
          // Report only once the log is flushed, so a failure's tail is complete.
          log.end(() => {
            const secs = Math.round((Date.now() - begin) / 1000);
            console.log(`${code === 0 ? "✔" : "✘"} ${label} (${secs}s)`);
            done({ label, logPath, ok: code === 0 });
          });
        };
        child.on("error", (error) => {
          log.write(`${error.message}\n`);
          finish(1);
        });
        child.on("close", finish);
      });
    }),
  );
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) {
    const lines = readFileSync(r.logPath, "utf8").trimEnd().split("\n");
    console.log(`\n── ${r.label} failed; last ${TAIL_LINES} lines of ${r.logPath} ──`);
    console.log(lines.slice(-TAIL_LINES).join("\n"));
  }
  console.log(`Group finished in ${Math.round((Date.now() - started) / 1000)}s.`);
  return failed.length === 0;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const ok = await runParallel(JSON.parse(process.argv[2]));
  process.exitCode = ok ? 0 : 1;
}
