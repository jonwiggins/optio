/**
 * Version checking service — fetches the latest Optio version from GHCR
 * and compares it with the current running version.
 */

const GHCR_API = "https://ghcr.io/v2";
const IMAGE_OWNER = process.env.OPTIO_IMAGE_OWNER ?? "jonwiggins";
const IMAGE_NAME = "optio-api";
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

let cachedLatest: { version: string | null; fetchedAt: number } | null = null;

/** Returns the current running version from the OPTIO_VERSION env var. */
export function getCurrentVersion(): string {
  return process.env.OPTIO_VERSION ?? "dev";
}

/** Returns true when the instance is running a local dev build (no version baked in). */
export function isLocalDev(): boolean {
  const v = process.env.OPTIO_VERSION;
  return !v || v === "dev";
}

/**
 * Fetch available tags from GHCR for the optio-api image.
 * Uses the OCI Distribution Spec tags/list endpoint which doesn't require auth
 * for public packages.
 */
async function fetchLatestTag(): Promise<string | null> {
  try {
    // First get an anonymous token for the GHCR registry
    const tokenRes = await fetch(
      `https://ghcr.io/token?scope=repository:${IMAGE_OWNER}/${IMAGE_NAME}:pull`,
    );
    if (!tokenRes.ok) return null;
    const { token } = (await tokenRes.json()) as { token: string };

    // List tags
    const tagsRes = await fetch(`${GHCR_API}/${IMAGE_OWNER}/${IMAGE_NAME}/tags/list`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!tagsRes.ok) return null;

    const { tags } = (await tagsRes.json()) as { tags: string[] };
    if (!tags || tags.length === 0) return null;

    // Filter to semver-like tags (e.g. "1.2.3") and sort descending
    const semverTags = tags
      .filter((t) => /^\d+\.\d+\.\d+$/.test(t))
      .sort((a, b) => compareSemver(b, a));

    return semverTags[0] ?? null;
  } catch {
    return null;
  }
}

/** Simple semver comparison: returns negative if a < b, positive if a > b, 0 if equal. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Get the latest version, using a 15-minute cache. */
export async function getLatestVersion(): Promise<string | null> {
  if (cachedLatest && Date.now() - cachedLatest.fetchedAt < CACHE_TTL_MS) {
    return cachedLatest.version;
  }

  const latest = await fetchLatestTag();
  cachedLatest = { version: latest, fetchedAt: Date.now() };
  return latest;
}

/** Get full version info (current + latest + whether an update is available). */
export async function getVersionInfo(): Promise<VersionInfo> {
  const current = getCurrentVersion();
  const latest = await getLatestVersion();

  let updateAvailable = false;
  if (latest && current !== "dev" && /^\d+\.\d+\.\d+$/.test(current)) {
    updateAvailable = compareSemver(latest, current) > 0;
  }

  return { current, latest, updateAvailable };
}
