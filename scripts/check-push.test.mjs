import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedSince,
  diffBase,
  freePort,
  plan,
  runChecks,
  verify,
  verifyUpdates,
} from "./check-push.mjs";

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), "optio-push-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  writeFileSync(join(root, "source.txt"), "original\n");
  git("add", ".");
  git("commit", "-qm", "initial");
  return { root, git };
}

test("only a successful check of the current commit authorizes its push", (t) => {
  const { root, git } = repo(t);
  assert.throws(() => verify(root), /No successful/);
  runChecks(root, [[process.execPath, "-e", "process.exit(0)"]]);
  const sha = git("rev-parse", "HEAD");
  assert.doesNotThrow(() =>
    verifyUpdates(root, `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`),
  );
  git("commit", "--allow-empty", "-qm", "new commit");
  assert.throws(() => verify(root), /changed/);
  runChecks(root, []);
  assert.throws(
    () => verifyUpdates(root, `refs/heads/old ${sha} refs/heads/old ${"0".repeat(40)}\n`),
    /other than/,
  );
});

test("edits and newly introduced source files invalidate verification", (t) => {
  const { root } = repo(t);
  runChecks(root, []);
  writeFileSync(join(root, "source.txt"), "edited\n");
  assert.throws(() => verify(root), /changed/);
  writeFileSync(join(root, "source.txt"), "original\n");
  assert.doesNotThrow(() => verify(root));
  writeFileSync(join(root, "new-source.txt"), "new\n");
  assert.throws(() => verify(root), /changed/);
});

test("a failing recheck revokes an older successful receipt", (t) => {
  const { root } = repo(t);
  runChecks(root, []);
  assert.throws(() => runChecks(root, [[process.execPath, "-e", "process.exit(1)"]]), /failed/);
  assert.throws(() => verify(root), /changed/);
});

test("checks cannot certify source that changes while they run", (t) => {
  const { root } = repo(t);
  assert.throws(
    () =>
      runChecks(root, [
        [process.execPath, "-e", "require('node:fs').writeFileSync('source.txt', 'changed')"],
      ]),
    /Files changed during/,
  );
  assert.throws(() => verify(root), /changed/);
});

test("the base is where the branch left its upstream, else main, and the last commit on it", (t) => {
  const { root, git } = repo(t);
  assert.equal(diffBase(root), null); // one commit, nothing to compare with
  git("branch", "baseline");
  git("branch", "--set-upstream-to=baseline");
  assert.equal(diffBase(root, { workingTree: true }).ref, "HEAD"); // on the base: only the edits
  const first = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "second");
  assert.equal(diffBase(root).sha, first); // on the base: the last commit
  git("branch", "-f", "baseline", "HEAD");
  mkdirSync(join(root, "apps/android"), { recursive: true });
  writeFileSync(join(root, "apps/android/model.kt"), "model");
  git("add", ".");
  git("commit", "-qm", "model change");
  git("commit", "--allow-empty", "-qm", "another commit");
  const base = diffBase(root);
  assert.equal(base.ref, "@{upstream}");
  assert.deepEqual(changedSince(root, base), ["apps/android/model.kt"]);
  // The working tree adds its edits and new files; the commits alone don't.
  writeFileSync(join(root, "source.txt"), "edited");
  writeFileSync(join(root, "untracked.txt"), "new");
  assert.deepEqual(changedSince(root, base), ["apps/android/model.kt"]);
  assert.deepEqual(changedSince(root, base, { workingTree: true }), [
    "apps/android/model.kt",
    "source.txt",
    "untracked.txt",
  ]);
  assert.equal(changedSince(root, null), null);
});

const base = { ref: "origin/main", sha: "0123456789abcdef0123456789abcdef01234567" };
const flat = (selection) => selection.groups.flat().map((c) => c.join(" "));
const has = (selection, text) => flat(selection).some((c) => c.includes(text));

test("an unknown change, or --full, runs everything CI runs", () => {
  const all = plan(null);
  assert.ok(has(all, "pnpm format:check"));
  assert.ok(has(all, "pnpm lint"));
  assert.ok(has(all, "pnpm knip"));
  assert.ok(has(all, "pnpm turbo typecheck") && !has(all, "--filter=..."));
  assert.ok(has(all, "pnpm turbo test") && !has(all, "--changed"));
  assert.ok(has(all, "check-swift-types") && has(all, "check-kotlin-types"));
  assert.ok(has(all, "security:audit") && has(all, "npm audit --prefix images/pi"));
  assert.ok(has(all, "check-android.sh"));
  assert.ok(has(all, "check-infra.sh"));
  assert.ok(has(all, "@optio/api test:coverage") && has(all, "@optio/api test:e2e"));
  assert.ok(has(all, "@optio/web test:e2e"));
  assert.deepEqual(all.skipped, []);
});

test("a docs change formats that file and type-checks what reaches it, nothing more", (t) => {
  const { root } = repo(t);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/tasks.md"), "# Tasks");
  const docs = plan(["docs/tasks.md", "docs/gone.md"], { base, root });
  assert.ok(has(docs, "prettier --check --ignore-unknown docs/tasks.md"));
  assert.ok(!has(docs, "docs/gone.md")); // deleted: nothing to format
  assert.ok(has(docs, "pnpm lint")); // whole repository, every time: cached and quick
  assert.ok(!has(docs, "pnpm knip")); // a document can't make an export unused
  assert.ok(has(docs, `pnpm turbo typecheck --filter=...[${base.sha}]`));
  assert.ok(
    has(
      docs,
      `pnpm turbo test --filter=...[${base.sha}] -- --changed ${base.sha} --passWithNoTests`,
    ),
  );
  for (const suite of [
    "format:check",
    "check-swift",
    "audit",
    "check-android",
    "check-infra",
    "@optio/api",
    "@optio/web",
  ])
    assert.ok(!has(docs, suite), suite);
  assert.equal(docs.skipped.length, 7);
});

test("an API service change narrows the integration tier and runs both server tiers", () => {
  const api = plan(["apps/api/src/services/task-service.ts"], { base });
  assert.ok(
    has(
      api,
      `vitest run --config vitest.integration.config.ts --changed ${base.sha} --passWithNoTests`,
    ),
  );
  assert.ok(!has(api, "test:coverage"));
  assert.ok(has(api, "@optio/api test:e2e") && has(api, "@optio/web test:e2e"));
  assert.ok(!has(api, "check-android") && !has(api, "check-swift") && !has(api, "audit"));
  assert.ok(has(api, "pnpm knip")); // a source change can leave an export unused anywhere
  assert.ok(has(plan(["apps/cli/package.json"], { base }), "pnpm knip")); // or a dependency
});

test("the browser suite runs on the ports the gate picked", async () => {
  const web = plan(["apps/web/src/app/page.tsx"], { base, webPorts: { api: 40001, web: 40002 } });
  assert.ok(
    has(
      web,
      "env OPTIO_E2E_API_PORT=40001 OPTIO_E2E_WEB_PORT=40002 pnpm --filter @optio/web test:e2e",
    ),
  );
  assert.ok(!has(plan(["apps/web/src/app/page.tsx"], { base }), "OPTIO_E2E"));
  const port = await freePort();
  assert.ok(Number.isInteger(port) && port > 1024);
});

test("a change to API test files alone reaches no server", () => {
  const tests = plan(
    ["apps/api/src/services/task-service.test.ts", "apps/api/src/db/x.int.test.ts"],
    { base },
  );
  assert.ok(has(tests, "--changed")); // the changed tests themselves run
  assert.ok(!has(tests, "@optio/api test:e2e") && !has(tests, "@optio/web test:e2e"));
  const withWeb = plan(["apps/api/src/a.test.ts", "apps/web/src/app/page.tsx"], { base });
  assert.ok(has(withWeb, "@optio/web test:e2e") && !has(withWeb, "@optio/api test:e2e"));
});

test("migrations, harnesses and dependency changes run the whole API tier", () => {
  for (const file of [
    "apps/api/src/db/migrations/1_x.sql",
    "apps/api/src/test-utils/e2e/setup.ts",
    "apps/api/vitest.config.ts",
  ]) {
    const wide = plan([file], { base });
    assert.ok(has(wide, "@optio/api test:coverage") && has(wide, "@optio/api test:e2e"), file);
    assert.ok(has(wide, "--filter=..."), file); // other packages still narrow
  }
  const lock = plan(["pnpm-lock.yaml"], { base });
  assert.ok(has(lock, "pnpm format:check") && has(lock, "security:audit"));
  assert.ok(
    has(lock, "pnpm turbo typecheck") && !has(lock, "--filter=...") && !has(lock, "--changed"),
  );
  assert.ok(
    has(lock, "@optio/api test:coverage") &&
      has(lock, "@optio/api test:e2e") &&
      has(lock, "@optio/web test:e2e"),
  );
});

test("shared types regenerate the Swift and Kotlin models; the gate always tests itself", () => {
  const shared = plan(["packages/shared/src/types/task.ts"], { base });
  assert.ok(has(shared, "check-swift-types") && has(shared, "check-kotlin-types"));
  assert.ok(has(shared, "--changed")); // vitest follows the import into the package source
  assert.ok(has(shared, "@optio/api test:e2e"));
  assert.ok(
    has(shared, "node --test scripts/check-push.test.mjs scripts/changed-surfaces.test.mjs"),
  );
  const scripts = plan(["scripts/test-infra.sh"], { base });
  assert.ok(has(scripts, "bash scripts/check-infra.sh")); // a shell script: the infra lint
  assert.ok(
    has(scripts, "node --test scripts/check-push.test.mjs scripts/changed-surfaces.test.mjs"),
  );
  assert.ok(!has(scripts, "scripts/offline")); // those need the self-hosting toolchain: CI's job
});
