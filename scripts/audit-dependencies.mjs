import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync("pnpm", ["audit", "--json"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
});
if (result.error || result.signal)
  throw result.error ?? new Error(`Audit stopped: ${result.signal}`);
let audit;
try {
  audit = JSON.parse(result.stdout);
} catch {
  throw new Error(`Dependency audit did not return JSON: ${result.stderr}`);
}
if (!audit.metadata?.vulnerabilities || audit.error) {
  throw new Error(`Dependency audit failed: ${JSON.stringify(audit.error ?? audit)}`);
}

// Zod 3 has no upstream release of this fix. Keep this one exception tied to
// the exact reviewed patch, then execute its regression tests below. New
// advisories, other versions and changed patches still fail the gate.
const patchPath = "patches/zod@3.25.76.patch";
const patchHash = "50b5f8f39d6eb63ea55352a19d7c5314a9a324507f32a5105d2c727fa004caf7";
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const patchApplied =
  manifest.pnpm?.patchedDependencies?.["zod@3.25.76"] === patchPath &&
  createHash("sha256")
    .update(readFileSync(new URL(`../${patchPath}`, import.meta.url)))
    .digest("hex") === patchHash;

const unpatched = [];
let localFixes = 0;
for (const advisory of Object.values(audit.advisories ?? {})) {
  if (
    patchApplied &&
    advisory.github_advisory_id === "GHSA-mrhx-c7xc-m3w5" &&
    advisory.module_name === "zod" &&
    advisory.findings?.length > 0 &&
    advisory.findings.every((finding) => finding.version === "3.25.76")
  ) {
    localFixes++;
  } else {
    unpatched.push(advisory);
  }
}
const reported = Object.values(audit.metadata.vulnerabilities).reduce(
  (sum, count) => sum + count,
  0,
);
if (unpatched.length || (reported > 0 && localFixes === 0) || ![0, 1].includes(result.status)) {
  for (const advisory of unpatched) {
    console.error(
      `${advisory.severity}: ${advisory.module_name} — ${advisory.title} (${advisory.url})`,
    );
  }
  throw new Error("Unpatched dependency advisories found; run pnpm audit for details.");
}
if (!patchApplied) throw new Error("The reviewed Zod patch is missing or has changed.");
const regression = spawnSync(
  "pnpm",
  [
    "--filter",
    "@optio/api",
    "exec",
    "vitest",
    "run",
    // These tests cover a dependency patch, not the application. Whole-API
    // coverage thresholds still run in the separate, complete unit-test job.
    "--coverage.enabled=false",
    "src/schemas/collection-limits.test.ts",
  ],
  { cwd: root, stdio: "inherit" },
);
if (regression.error || regression.status !== 0) {
  throw regression.error ?? new Error("Zod security regressions failed.");
}
console.warn(
  `Dependency audit passed: ${localFixes} advisory covered by the verified local Zod patch; no unpatched advisories.`,
);
