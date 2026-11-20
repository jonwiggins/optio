/**
 * The workspace this browser's pages use, as the workspace switcher stores
 * it. API calls send it as `x-workspace-id`; sockets can't set headers, so it
 * also rides on the `optio_workspace` cookie (sent with every same-origin
 * WebSocket upgrade) and, for token-authenticated sockets, an
 * `optio-workspace-<id>` subprotocol. The API reads all three the same way,
 * so a page's live events and log streams follow the workspace its lists
 * come from rather than the user's saved default.
 */
export const WORKSPACE_STORAGE_KEY = "optio_workspace_id";
const COOKIE = "optio_workspace";

export function getActiveWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(WORKSPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Keep the `optio_workspace` cookie equal to the stored workspace (cleared without one). */
export function syncWorkspaceCookie(workspaceId: string | null = getActiveWorkspaceId()): void {
  if (typeof document === "undefined") return;
  const current = document.cookie.match(/(?:^|;\s*)optio_workspace=([^;]*)/)?.[1];
  if (workspaceId) {
    const value = encodeURIComponent(workspaceId);
    if (current !== value) document.cookie = `${COOKIE}=${value}; path=/; SameSite=Lax`;
  } else if (current !== undefined) {
    document.cookie = `${COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  }
}

/** The subprotocol naming the stored workspace, for a socket that authenticates with a token. */
export function workspaceProtocols(): string[] {
  const id = getActiveWorkspaceId();
  return id ? [`optio-workspace-${id}`] : [];
}
