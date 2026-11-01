import { test } from "node:test";
import assert from "node:assert/strict";
import { surfaces } from "./changed-surfaces.mjs";

const none = { android: false, api: false, web: false };

test("an unknown change runs every suite", () => {
  assert.deepEqual(surfaces(null), { android: true, api: true, web: true });
});

test("docs, iOS and the site need none of the slow suites", () => {
  assert.deepEqual(
    surfaces(["docs/tasks.md", "apps/ios/Optio/App.swift", "apps/site/page.tsx"]),
    none,
  );
});

test("each app runs its own suites; API changes also run the browser suite", () => {
  assert.deepEqual(surfaces(["apps/android/app/build.gradle.kts"]), { ...none, android: true });
  assert.deepEqual(surfaces(["apps/web/src/app/page.tsx"]), { ...none, web: true });
  assert.deepEqual(surfaces(["apps/api/src/server.ts"]), { ...none, api: true, web: true });
});

test("shared packages, dependencies, scripts and CI run every JS suite", () => {
  for (const file of [
    "packages/shared/src/index.ts",
    "pnpm-lock.yaml",
    "package.json",
    "scripts/test-infra.sh",
  ])
    assert.deepEqual(surfaces([file]), { ...none, api: true, web: true }, file);
  assert.deepEqual(surfaces([".github/workflows/ci.yml"]), { android: true, api: true, web: true });
});
