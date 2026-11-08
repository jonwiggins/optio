/**
 * Version checking service — fetches the latest Optio version from GHCR
 * and compares it with the current running version.
 *
 * A deployment can turn the check off (`OPTIO_UPDATE_CHECK=false`, chart
 * `updates.check: false`), e.g. one with no route to the internet or one
 * upgraded only through its own Helm / Zarf pipeline. Then nothing here
 * contacts a registry, the web shows no update banner and the in-app
 * update (`POST /api/cluster/update`) is refused.
 */

const GHCR_API = "https://ghcr.io/v2";
const IMAGE_OWNER = process.env.OPTIO_IMAGE_OWNER ?? "jonwiggins";
const IMAGE_NAME = "optio-api";
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const FETCH_TIMEOUT_MS = 5_000;

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** False when the deployment turned the update check and in-app update off. */
  updateCheck: boolean;
}

let cachedLatest: { version: string | null; fetchedAt: number } | null = null;

/** Returns the current running version from the OPTIO_VERSION env var. */
function getCurrentVersion(): string {
  return process.env.OPTIO_VERSION ?? "dev";
}

/**
 * Whether this deployment checks for new releases and offers the in-app
 * update. On unless `OPTIO_UPDATE_CHECK` says false (`false`, `0`, `no`, `off`).
 */
export function isUpdateCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.OPTIO_UPDATE_CHECK ?? "").trim().toLowerCase();
  return !["false", "0", "no", "off"].includes(raw);
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
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!tokenRes.ok) return null;
    const { token } = (await tokenRes.json()) as { token: string };

    // List tags
    const tagsRes = await fetch(`${GHCR_API}/${IMAGE_OWNER}/${IMAGE_NAME}/tags/list`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

/** Forget the cached latest version (tests). */
export function resetVersionCache(): void {
  cachedLatest = null;
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

/** Get the latest version, using a 15-minute cache. Null, with no request, when the check is off. */
export async function getLatestVersion(): Promise<string | null> {
  if (!isUpdateCheckEnabled()) return null;
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
  if (!isUpdateCheckEnabled()) {
    return { current, latest: null, updateAvailable: false, updateCheck: false };
  }
  const latest = await getLatestVersion();

  let updateAvailable = false;
  if (latest && current !== "dev" && /^\d+\.\d+\.\d+$/.test(current)) {
    updateAvailable = compareSemver(latest, current) > 0;
  }

  return { current, latest, updateAvailable, updateCheck: true };
}
