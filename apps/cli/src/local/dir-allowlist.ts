import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { LocalHostDir } from "@optio/shared";
import { loadLocalConfig, saveLocalConfig } from "../config/local-store.js";
import { detectRepoUrl } from "./git-remote.js";

/**
 * The Optio Local directory allowlist in `local.json`: the directories this
 * machine offers as places to run work. `optio local add|remove` edit it
 * here, and the daemon edits it when Optio asks (a `dirs` frame from the
 * Machines page or the New work form). The daemon re-reads the file for
 * every spawn, so a change applies to the next one.
 */

/** Why a directory can't be added or removed, worded for whoever asked. */
export class DirAllowlistError extends Error {}

export interface DirChange {
  /** The directory as stored: `~` expanded, symlinks followed. */
  path: string;
  /** Its git remote, when it is a checkout. */
  repoUrl?: string;
  /** Add: it was already listed (its remote was re-detected). */
  alreadyAdded?: boolean;
  /** The whole allowlist after the change. */
  dirs: LocalHostDir[];
}

export interface DirOptions {
  /** Base for a relative `dir` (the CLI's cwd). */
  cwd?: string;
  /**
   * Asked for by Optio rather than typed on this machine: the path must be
   * absolute (or under `~`), since the daemon's cwd means nothing to the
   * person who asked, and the filesystem root is refused.
   */
  remote?: boolean;
}

/** `~` or `~/x` → under the home directory; anything else as given. */
export function expandHome(dir: string, home = homedir()): string {
  if (dir === "~") return home;
  if (dir.startsWith("~/")) return join(home, dir.slice(2));
  return dir;
}

function requested(dir: string, opts: DirOptions): string {
  const trimmed = dir.trim();
  if (!trimmed) throw new DirAllowlistError("Give a directory");
  const expanded = expandHome(trimmed);
  if (opts.remote && !isAbsolute(expanded)) {
    throw new DirAllowlistError(`Give an absolute path (or one under ~), not "${trimmed}"`);
  }
  return resolve(opts.cwd ?? process.cwd(), expanded);
}

/** Add `dir` to the allowlist, or re-detect its git remote when it's listed already. */
export async function addAllowedDir(dir: string, opts: DirOptions = {}): Promise<DirChange> {
  const raw = requested(dir, opts);
  let path: string;
  try {
    path = realpathSync(raw);
  } catch {
    throw new DirAllowlistError(`No such directory on this machine: ${raw}`);
  }
  if (!statSync(path).isDirectory()) {
    throw new DirAllowlistError(`Not a directory: ${path}`);
  }
  if (opts.remote && path === "/") {
    throw new DirAllowlistError(
      "Pick a project directory — the filesystem root can only be added on the machine itself",
    );
  }

  const repoUrl = await detectRepoUrl(path);
  const config = loadLocalConfig();
  const existing = config.dirs.find((d) => d.path === path);
  if (existing) {
    if (repoUrl) existing.repoUrl = repoUrl;
    else delete existing.repoUrl;
  } else {
    config.dirs.push(repoUrl ? { path, repoUrl } : { path });
  }
  saveLocalConfig(config);
  return {
    path,
    ...(repoUrl ? { repoUrl } : {}),
    alreadyAdded: Boolean(existing),
    dirs: config.dirs,
  };
}

/** Take `dir` off the allowlist. A directory that has since been deleted can still be removed. */
export function removeAllowedDir(dir: string, opts: DirOptions = {}): DirChange {
  const raw = requested(dir, opts);
  let resolved = raw;
  try {
    resolved = realpathSync(raw);
  } catch {
    // Gone from disk — still allow removing its entry.
  }
  const config = loadLocalConfig();
  const before = config.dirs.length;
  config.dirs = config.dirs.filter((d) => d.path !== resolved && d.path !== raw);
  if (config.dirs.length === before) {
    throw new DirAllowlistError(`${raw} is not in the allowlist`);
  }
  saveLocalConfig(config);
  return { path: resolved, dirs: config.dirs };
}
