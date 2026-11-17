"use client";

import { useEffect } from "react";

/** Where the workspace switcher stores the browser's workspace. */
const WORKSPACE_STORAGE_KEY = "optio_workspace_id";

/**
 * The workspace is stored per browser, and every API call sends it. When
 * another tab switches workspace, this tab's next calls already go to the new
 * one while its page still shows the old one's lists, name and live events.
 * Reload, as the switch does in the tab it was made in.
 */
export function useWorkspaceSync(): void {
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== WORKSPACE_STORAGE_KEY || e.newValue === e.oldValue) return;
      window.location.reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
}
