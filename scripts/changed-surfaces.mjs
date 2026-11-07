#!/usr/bin/env node
// Which slow suites a change needs. CI's `changes` job and `pnpm check:push` share these rules,
// so a suite is skipped in exactly the same cases in both places. Unknown = run everything.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SURFACES = ["android", "api", "images", "web"];

// Files that can change how anything builds or runs: every suite runs.
const GLOBAL = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^turbo\.json$/,
  /^\.node-version$/,
  /^tsconfig[^/]*\.json$/,
  /^\.github\//,
  /^scripts\//,
  /^packages\//,
];

const RULES = {
  // Generated Kotlin models live under apps/android, so a shared type change lands here too.
  android: [/^apps\/android\//],
  api: [/^apps\/api\//],
  // The agent images: what build-images.yml publishes from (its `paths`), kept in step with it.
  images: [
    /^images\//,
    /^scripts\/repo-init\.sh$/,
    /^scripts\/optio-git-credential$/,
    /^scripts\/optio-gh-wrapper$/,
    /^scripts\/optio-glab-wrapper$/,
    /^scripts\/check-preinstalled-mcp\.mjs$/,
    /^packages\/mcp-bridge\//,
    /^patches\//,
  ],
  // The browser suite drives the real API, so API changes run it as well.
  web: [/^apps\/web\//, /^apps\/api\//],
};

/** @param {string[] | null} files changed paths, or null when the change is unknown */
export function surfaces(files) {
  if (files === null) return Object.fromEntries(SURFACES.map((s) => [s, true]));
  // Android builds with Gradle, not pnpm: only its own files and its CI/check scripts matter.
  const ci = /^\.github\/workflows\/ci\.yml$/;
  const androidGlobal = [ci, /^scripts\/check-android\.sh$/];
  // Docker builds the images from their own inputs; pnpm and the JS packages don't reach them.
  const imagesGlobal = [ci];
  return {
    android: files.some((f) => [...RULES.android, ...androidGlobal].some((r) => r.test(f))),
    api: files.some((f) => [...RULES.api, ...GLOBAL].some((r) => r.test(f))),
    images: files.some((f) => [...RULES.images, ...imagesGlobal].some((r) => r.test(f))),
    web: files.some((f) => [...RULES.web, ...GLOBAL].some((r) => r.test(f))),
  };
}

export function changedFiles(root, base) {
  try {
    const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
      cwd: root,
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return null; // base not fetched or not an ancestor: no safe comparison
  }
}

// CI: `node scripts/changed-surfaces.mjs <base-sha>` writes android=/api=/web= to $GITHUB_OUTPUT.
// No base (a push to main, a manual run) means run everything.
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const base = process.argv[2];
  const result = surfaces(base ? changedFiles(process.cwd(), base) : null);
  const lines = SURFACES.map((s) => `${s}=${result[s]}`);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}
