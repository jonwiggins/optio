import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { LocalHostDir } from "@optio/shared";
import { expandHome } from "./dir-allowlist.js";

/**
 * `optio local up --dir <path>`: directories the daemon offers for this run
 * only, next to the allowlist in local.json (which they are never written
 * to). A remote workspace passes its checkout this way (docs/remote-workspaces.md), so a
 * fresh workspace needs no `optio local add`.
 *
 * Resolved on every (re)connect, the way `optio local add` stores a path
 * (`~` expanded, symlinks followed): a checkout that isn't there yet is
 * left out until it is.
 */
export function resolveFlagDirs(
  dirs: readonly string[],
  cwd = process.cwd(),
): { paths: string[]; missing: string[] } {
  const paths: string[] = [];
  const missing: string[] = [];
  for (const dir of dirs) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const raw = resolve(cwd, expandHome(trimmed));
    let path: string;
    try {
      path = realpathSync(raw);
      if (!statSync(path).isDirectory()) throw new Error("not a directory");
    } catch {
      missing.push(raw);
      continue;
    }
    if (!paths.includes(path)) paths.push(path);
  }
  return { paths, missing };
}

/** The allowlist with the `--dir` directories it doesn't list already. */
export function withFlagDirs(listed: LocalHostDir[], flagDirs: LocalHostDir[]): LocalHostDir[] {
  return [...listed, ...flagDirs.filter((f) => !listed.some((d) => d.path === f.path))];
}

/** Commander's collector for a repeatable option. */
export function collectDir(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}
