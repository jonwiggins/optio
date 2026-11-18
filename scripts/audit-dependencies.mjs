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

// picomatch, GHSA-fc5q-39xc-vjpf (ReDoS on crafted extglob *patterns*), accepted 2026-11-17: every
// release through the newest (4.0.7) is affected and none is patched; the fix the advisory links,
// https://github.com/micromatch/picomatch/pull/194, is not merged. Here picomatch is only in
// development tooling (knip, lint-staged, tinyglobby, vite, vitest), which matches globs we wrote.
// The exception holds only while all of this is true, and the gate fails again otherwise:
//   1. it is this advisory, for the package picomatch;
//   2. the advisory names no patched version (pnpm reports that as "<0.0.0") — once a fix ships,
//      bump or override to it and delete this block;
//   3. `pnpm audit --prod` does not report it — picomatch has not reached a production path.
const PICOMATCH_ADVISORY = "GHSA-fc5q-39xc-vjpf";
const isPicomatchAdvisory = (advisory) =>
  advisory.github_advisory_id === PICOMATCH_ADVISORY && advisory.module_name === "picomatch";
let picomatchOutOfProduction;
function picomatchAccepted(advisory) {
  if (!isPicomatchAdvisory(advisory) || advisory.patched_versions !== "<0.0.0") return false;
  if (picomatchOutOfProduction === undefined) {
    const prod = spawnSync("pnpm", ["audit", "--prod", "--json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    let prodAudit;
    try {
      prodAudit = JSON.parse(prod.stdout);
    } catch {
      prodAudit = undefined;
    }
    // Anything but a clean, complete answer counts as "in production".
    picomatchOutOfProduction =
      !prod.error &&
      !prod.signal &&
      [0, 1].includes(prod.status) &&
      Boolean(prodAudit?.metadata?.vulnerabilities) &&
      !prodAudit.error &&
      !Object.values(prodAudit.advisories ?? {}).some(
        (found) => found.module_name === "picomatch" || isPicomatchAdvisory(found),
      );
  }
  return picomatchOutOfProduction;
}

const unpatched = [];
let localFixes = 0;
let accepted = 0;
for (const advisory of Object.values(audit.advisories ?? {})) {
  if (picomatchAccepted(advisory)) {
    accepted++;
    console.warn(
      `Accepted (no patched release, development tooling only): ${advisory.module_name} — ${advisory.title} (${advisory.url})`,
    );
    continue;
  }
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
if (
  unpatched.length ||
  (reported > 0 && localFixes + accepted === 0) ||
  ![0, 1].includes(result.status)
) {
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
