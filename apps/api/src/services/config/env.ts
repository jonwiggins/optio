/**
 * What the deployment declares about config as code — `OPTIO_CONFIG_DIR` and
 * its companions. Its own module, with no imports from the rest of the
 * service, so the list decorators can ask "is this even on?" cheaply.
 */
import { parseIntEnv } from "@optio/shared";

export interface EnvConfigSource {
  /** The directory in the API pod. */
  dir: string;
  /** The workspace's slug, or null for the oldest workspace. */
  workspace: string | null;
  /** Delete what the directory no longer declares (default true). */
  prune: boolean;
  /** How often the directory is read (default 60s, at least 10s). */
  intervalMs: number;
}

/** The directory source the env declares, or null when config as code is off. */
export function envConfigSource(): EnvConfigSource | null {
  const dir = process.env.OPTIO_CONFIG_DIR?.trim();
  if (!dir) return null;
  const prune = (process.env.OPTIO_CONFIG_PRUNE ?? "true").trim().toLowerCase();
  return {
    dir,
    workspace: process.env.OPTIO_CONFIG_WORKSPACE?.trim() || null,
    prune: !["false", "0", "no", "off"].includes(prune),
    intervalMs: Math.max(10_000, parseIntEnv("OPTIO_CONFIG_INTERVAL", 60_000)),
  };
}
