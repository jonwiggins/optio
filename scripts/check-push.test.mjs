import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushSurfaces, runChecks, verify, verifyUpdates } from "./check-push.mjs";

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

test("changes in any unpushed commit pick the suites they touch", (t) => {
  const { root, git } = repo(t);
  assert.equal(pushSurfaces(root).android, true); // no upstream
  git("branch", "baseline");
  git("branch", "--set-upstream-to=baseline");
  mkdirSync(join(root, "apps/android"), { recursive: true });
  writeFileSync(join(root, "apps/android/model.kt"), "model");
  git("add", ".");
  git("commit", "-qm", "model change");
  git("commit", "--allow-empty", "-qm", "another commit");
  assert.equal(pushSurfaces(root).android, true);
  git("branch", "-f", "baseline", "HEAD");
  assert.equal(pushSurfaces(root).android, false); // last commit changes nothing
  writeFileSync(join(root, "source.txt"), "web only");
  git("add", ".");
  git("commit", "-qm", "web change");
  assert.equal(pushSurfaces(root).android, false);
  assert.equal(pushSurfaces(root).web, false); // a root text file touches no suite
  mkdirSync(join(root, "apps/web"), { recursive: true });
  writeFileSync(join(root, "apps/web/page.tsx"), "page");
  git("add", ".");
  git("commit", "-qm", "page");
  assert.deepEqual(pushSurfaces(root), { android: false, api: false, web: true });
});
