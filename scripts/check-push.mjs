#!/usr/bin/env node
// The local gate CI's rules are measured against, sized to the change:
//
//   pnpm check:push      the commits about to be pushed; writes the receipt the pre-push hook
//                        (`--verify`) reads, so an idle SSH timeout can't discard a long run
//   pnpm check:changed   the same selection for the working tree while you work; no receipt
//   --full               CI parity: every suite, nothing narrowed (what a push to main runs)
//   --plan               print what would run and why, run nothing
//
// Selection: changed-surfaces.mjs decides which slow suites a change can reach (the same rules
// CI's `changes` job uses to skip them); plan() then narrows the test tiers to the packages
// and test files the change touches. The rules are in plan(), each with its reason.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { surfaces } from "./changed-surfaces.mjs";

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const receiptPath = (root) =>
  resolve(root, git(root, "rev-parse", "--git-path", "optio-push-check.json"));

export function snapshot(root) {
  const hash = createHash("sha256");
  hash.update(`${process.platform}\0${process.arch}\0${process.version}\0`);
  const files = git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const file of files) {
    hash.update(`${file}\0`);
    try {
      const path = resolve(root, file);
      const stat = lstatSync(path);
      hash.update(`${stat.mode}\0`);
      hash.update(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update("missing");
    }
    hash.update("\0");
  }
  return { head: git(root, "rev-parse", "HEAD"), files: hash.digest("hex") };
}

const same = (a, b) => a?.head === b.head && a?.files === b.files;

export function verify(root) {
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath(root), "utf8"));
  } catch {
    throw new Error("No successful push checks. Run pnpm check:push, then git push.");
  }
  if (!same(receipt, snapshot(root))) {
    throw new Error(
      "Commit, files, or Node environment changed since verification. Run pnpm check:push again.",
    );
  }
}

export function verifyUpdates(root, input) {
  verify(root);
  const head = git(root, "rev-parse", "HEAD");
  for (const line of input.trim().split("\n").filter(Boolean)) {
    const [, sha] = line.split(/\s+/);
    if (/^0+$/.test(sha)) continue; // deleting a remote ref
    if (git(root, "rev-parse", `${sha}^{commit}`) !== head) {
      throw new Error(
        "Push includes a commit other than the verified checkout. Check out and verify that commit first.",
      );
    }
  }
}

/**
 * The commit a change is measured from: where the branch left its upstream, else origin/main,
 * else main. On the base itself (nothing to push yet, or just pushed) the last commit is the
 * change — or, for the working tree, HEAD, so only the edits count. Null when there is nothing
 * to compare with: then everything runs.
 */
export function diffBase(root, { workingTree = false } = {}) {
  const head = git(root, "rev-parse", "HEAD");
  for (const ref of ["@{upstream}", "origin/main", "main"]) {
    let sha;
    try {
      sha = git(root, "merge-base", ref, "HEAD");
    } catch {
      continue;
    }
    if (sha !== head) return { ref, sha };
    if (workingTree) return { ref: "HEAD", sha: head };
    try {
      return { ref: "HEAD^", sha: git(root, "rev-parse", "--verify", "HEAD^") };
    } catch {
      return null;
    }
  }
  return null;
}

/** Paths the change touches: the commits since `base`, plus edits and new files with `workingTree`. */
export function changedSince(root, base, { workingTree = false } = {}) {
  if (!base) return null;
  const files = git(root, "diff", "--name-only", ...(workingTree ? [base.sha] : [base.sha, "HEAD"]))
    .split("\n")
    .filter(Boolean);
  if (workingTree)
    files.push(...git(root, "ls-files", "--others", "--exclude-standard").split("\n"));
  return [...new Set(files.filter(Boolean))].sort();
}

// Files that change how every package installs, builds, tests or type-checks: nothing narrows.
const GLOBAL = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^\.npmrc$/,
  /^turbo\.json$/,
  /^\.node-version$/,
  /^tsconfig[^/]*\.json$/,
  /^patches\//,
];
// Formatting rules: with one of these changed, every file is checked, as CI does.
const FORMAT_CONFIG = [/^\.prettierrc/, /^\.prettierignore$/, /^\.editorconfig$/, ...GLOBAL];
// The generated Swift and Kotlin models follow packages/shared (its types and generators).
const TYPE_SYNC = [
  /^packages\/shared\//,
  /^apps\/ios\/Optio\/Generated\//,
  /^apps\/android\/core\/model\/src\/main\/kotlin\/dev\/optio\/core\/model\/SharedTypes\.kt$/,
  /^scripts\/check-(swift|kotlin)-types\.sh$/,
];
// Dependency audits: what pnpm and the two image package sets install, and the audit's own rules.
const AUDIT = [
  /(^|\/)package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^\.npmrc$/,
  /^patches\//,
  /^images\/(openclaw|pi)\//,
  /^scripts\/audit-dependencies\.mjs$/,
];
// API changes vitest can't trace through imports: migrations and SQL (the template database),
// the test harnesses and configs, and anything outside src/ and e2e/. The whole tier runs.
const API_WIDE = [
  /^apps\/api\/src\/db\//,
  /^apps\/api\/src\/test-utils\//,
  /^apps\/api\/vitest/,
  /^apps\/api\/(?!src\/|e2e\/)/,
  /^apps\/api\/.*\.(sql|json|ya?ml)$/,
];
// Infrastructure code: shell scripts, Dockerfiles, the chart, and the linters' own config.
const INFRA = [
  /\.sh$/,
  /^\.husky\//,
  /^scripts\/optio-(gh-wrapper|git-credential|glab-wrapper)$/,
  /^Dockerfile/,
  /\.Dockerfile$/,
  /^helm\//,
  /^\.(shellcheckrc|hadolint\.yaml)$/,
];
// Dead code (knip): what can add or remove a reference — source files, package manifests, the
// tsconfigs knip resolves paths through, its own config. The whole repository, since a removed
// import makes an export unused anywhere.
const DEAD_CODE = [
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/,
  /(^|\/)package\.json$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /^knip\.jsonc$/,
  ...GLOBAL,
];
// Unit and integration test files: a change to one of these alone reaches no server.
const API_TEST_FILE = /^apps\/api\/src\/.*\.test\.ts$/;

/**
 * What to run for a change: two groups of commands (each group's commands run at once, the
 * second group after the first), and what was skipped, with the reason. `files` null (unknown
 * change, or --full) means everything CI runs.
 */
export function plan(files, { base = null, root = process.cwd(), webPorts = null } = {}) {
  const any = (rules) => files === null || files.some((f) => rules.some((r) => r.test(f)));
  const reach = surfaces(files);
  const global = any(GLOBAL);
  // The ref the test tiers narrow to: packages changed since it (turbo), tests whose imports
  // changed since it (vitest --changed, which also reads uncommitted edits).
  const since = base && !global ? base.sha : null;
  const fast = [];
  const slow = [];
  const skipped = [];

  // The gate's own tests, always (a second). The other scripts/ tests need the self-hosting
  // toolchain (Docker, Syft, Trivy) and run in CI's Test job, not here.
  fast.push(["node", "--test", "scripts/check-push.test.mjs", "scripts/changed-surfaces.test.mjs"]);

  // Lint the whole repository: a changed rule or config reaches files the diff doesn't name,
  // and the cache (node_modules/.cache/eslint) makes the unchanged ones free, so it takes seconds.
  fast.push(["pnpm", "lint"]);

  if (any(DEAD_CODE)) fast.push(["pnpm", "knip"]);
  else skipped.push("dead code (no source file or package manifest changed)");

  if (any(FORMAT_CONFIG)) fast.push(["pnpm", "format:check"]);
  else {
    const present = files.filter((f) => existsSync(resolve(root, f)));
    if (present.length)
      fast.push(["pnpm", "exec", "prettier", "--check", "--ignore-unknown", ...present]);
    else skipped.push("formatting (no files left to check)");
  }

  // Typecheck the packages the change reaches (turbo follows dependents); unit-test only the
  // files whose import graph changed. Both in group two: turbo builds dependencies first, and
  // two turbo runs at once would race on that.
  const filter = since ? [`--filter=...[${since}]`] : [];
  fast.push(["pnpm", "turbo", "typecheck", ...filter]);
  slow.push([
    "pnpm",
    "turbo",
    "test",
    ...filter,
    ...(since ? ["--", "--changed", since, "--passWithNoTests"] : []),
  ]);

  if (any(TYPE_SYNC)) {
    fast.push(["bash", "scripts/check-swift-types.sh"]);
    fast.push(["bash", "scripts/check-kotlin-types.sh"]);
  } else skipped.push("Swift/Kotlin types (packages/shared unchanged)");

  if (any(AUDIT)) {
    fast.push(["pnpm", "security:audit"]);
    fast.push(["npm", "audit", "--prefix", "images/openclaw", "--omit=dev", "--audit-level=low"]);
    fast.push(["npm", "audit", "--prefix", "images/pi", "--omit=dev", "--audit-level=low"]);
  } else skipped.push("dependency audits (no dependency changed)");

  if (any(INFRA)) fast.push(["bash", "scripts/check-infra.sh"]);
  else skipped.push("infra lint (no shell script, Dockerfile or chart changed)");

  if (reach.android) slow.push(["bash", "scripts/check-android.sh"]);
  else skipped.push("Android (apps/android unchanged)");

  // An API change that is only unit or integration test files reaches no server: the two
  // server tiers (API e2e, browser e2e) run for anything else the api surface covers.
  const apiFiles = files === null ? null : files.filter((f) => /^apps\/api\//.test(f));
  const apiTestsOnly =
    !global &&
    apiFiles !== null &&
    apiFiles.length > 0 &&
    apiFiles.every((f) => API_TEST_FILE.test(f));
  if (reach.api) {
    if (since && !any(API_WIDE))
      slow.push([
        "pnpm",
        "--filter",
        "@optio/api",
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.integration.config.ts",
        "--changed",
        since,
        "--passWithNoTests",
      ]);
    else slow.push(["pnpm", "--filter", "@optio/api", "test:coverage"]);
    if (apiTestsOnly) skipped.push("API e2e (only API test files changed)");
    else slow.push(["pnpm", "--filter", "@optio/api", "test:e2e"]);
  } else skipped.push("API integration and e2e (apps/api unchanged)");

  if (reach.web && !(apiTestsOnly && !files.some((f) => /^apps\/web\//.test(f))))
    // On ports of its own, so another worktree's stack (or a leftover one) is never in the way.
    slow.push([
      ...(webPorts
        ? ["env", `OPTIO_E2E_API_PORT=${webPorts.api}`, `OPTIO_E2E_WEB_PORT=${webPorts.web}`]
        : []),
      "pnpm",
      "--filter",
      "@optio/web",
      "test:e2e",
    ]);
  else skipped.push("web e2e (apps/web and the API's runtime unchanged)");

  return { groups: [fast, slow].filter((g) => g.length), skipped };
}

/** A free TCP port on the loopback interface. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function describe(base, files, { groups, skipped }) {
  if (files === null) console.log("Running everything CI runs (no base to narrow to, or --full).");
  else {
    const shown =
      files.slice(0, 12).join(", ") + (files.length > 12 ? `, … ${files.length - 12} more` : "");
    console.log(
      `Since ${base.ref} (${base.sha.slice(0, 8)}): ${files.length} changed file(s): ${shown}`,
    );
  }
  groups.forEach((group, i) => {
    console.log(`Group ${i + 1}:`);
    for (const command of group) {
      const shown =
        command.length > 12 ? [...command.slice(0, 12), `… ${command.length - 12} more`] : command;
      console.log(`  ${shown.join(" ")}`);
    }
  });
  if (skipped.length) console.log(`Skipping: ${skipped.join("; ")}`);
}

function runCommands(root, commands) {
  for (const [command, ...args] of commands) {
    console.log(`\nChecking: ${[command, ...args].join(" ")}`);
    // Exercise CI-only behavior (including coverage) before the push too.
    const result = spawnSync(command, args, {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, CI: "true" },
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `${command} failed (${result.signal ?? result.status}); push remains blocked.`,
      );
  }
}

/** Run the commands and, when every one passes, write the receipt the pre-push hook reads. */
export function runChecks(root, commands) {
  // A receipt validates committed work, not edits that happen to be left unstaged.
  git(root, "diff", "--quiet", "HEAD", "--");
  const before = snapshot(root);
  // Invalidate an older success before a recheck, including a failed recheck.
  writeFileSync(receiptPath(root), "{}\n");
  runCommands(root, commands);
  if (!same(before, snapshot(root)))
    throw new Error("Files changed during checks; commit the changes and rerun pnpm check:push.");
  writeFileSync(receiptPath(root), `${JSON.stringify(before)}\n`);
  console.log(`Push checks passed for ${before.head}. You can now git push.`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = git(process.cwd(), "rev-parse", "--show-toplevel");
    const flags = new Set(process.argv.slice(2));
    if (flags.has("--verify")) verifyUpdates(root, readFileSync(0, "utf8"));
    else {
      const workingTree = flags.has("--working-tree");
      const base = flags.has("--full") ? null : diffBase(root, { workingTree });
      const files = changedSince(root, base, { workingTree });
      const webPorts = { api: await freePort(), web: await freePort() };
      const selection = plan(files, { base, root, webPorts });
      describe(base, files, selection);
      if (!flags.has("--plan")) {
        // Commands that share no state run at once: each group is one step, logs in .git/optio-check-logs.
        const commands = selection.groups.map((group) => [
          "node",
          "scripts/run-parallel.mjs",
          JSON.stringify(group),
        ]);
        if (workingTree) runCommands(root, commands);
        else runChecks(root, commands);
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
