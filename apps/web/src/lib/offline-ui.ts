/**
 * The offline UI (OPTIO_OFFLINE_UI=true on the web container, chart
 * `web.offline`; docs/air-gapped.md): for a network whose browsers reach
 * only internal services. The UI then loads no image from a host outside
 * the deployment and offers no link to a page outside it:
 *
 * - avatars the sign-in provider gave (often Gravatar or github.com URLs)
 *   show only when they are on this page's origin or the API's, else the
 *   usual placeholder. Nothing is proxied: an API that fetched URLs for the
 *   browser would be a way to reach arbitrary hosts from inside the cluster.
 * - help and vendor links (token pages, key consoles, the changelog, the
 *   guide's outside links) are left out, with the sentences that lead to them.
 *
 * Off (the default) changes nothing. The root layout puts the setting into
 * `window.__OPTIO_CONFIG.offlineUi`; the server reads the env directly.
 */

/** What the root layout adds to `window.__OPTIO_CONFIG`: nothing unless the setting is on. */
export function offlineUiConfig(env: Record<string, string | undefined> = process.env): {
  offlineUi?: true;
} {
  return env.OPTIO_OFFLINE_UI?.trim().toLowerCase() === "true" ? { offlineUi: true } : {};
}

/** Whether the offline UI is on for this deployment. */
export function isOfflineUi(): boolean {
  if (typeof window === "undefined") return offlineUiConfig().offlineUi === true;
  const config = (window as any).__OPTIO_CONFIG as { offlineUi?: unknown } | undefined;
  return config?.offlineUi === true;
}

/** The origins an image may come from with the offline UI on: the page's and the API's. */
export function deploymentOrigins(): string[] {
  if (typeof window === "undefined") return [];
  const origins = [window.location.origin];
  const config = (window as any).__OPTIO_CONFIG as { publicApiUrl?: unknown } | undefined;
  if (typeof config?.publicApiUrl === "string" && config.publicApiUrl) {
    try {
      origins.push(new URL(config.publicApiUrl).origin);
    } catch {
      // not a URL: only the page's own origin
    }
  }
  return origins;
}

/**
 * The URL to load an image (an avatar) from, or null to show the placeholder.
 * With the offline UI off it is the URL as given; on, only a URL on one of
 * `origins` (a relative one counts as the page's), or a data: URI.
 */
export function displayableImageUrl(
  url: string | null | undefined,
  offline: boolean = isOfflineUi(),
  origins: string[] = deploymentOrigins(),
): string | null {
  if (!url) return null;
  if (!offline) return url;
  if (url.startsWith("data:image/")) return url;
  try {
    const base = origins[0] ?? "http://invalid.invalid";
    const parsed = new URL(url, base);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return origins.includes(parsed.origin) ? url : null;
  } catch {
    return null;
  }
}
