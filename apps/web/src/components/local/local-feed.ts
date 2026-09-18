"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@/lib/api-client";
import { createEventsClient } from "@/lib/ws-client";
import { getWsTokenProvider } from "@/lib/ws-auth";

/**
 * One live feed of the user's local terminals + hosts, shared by every
 * consumer on the Local pages (rail, attention watcher, …) so there is a
 * single WS subscription and poll no matter how many components care.
 *
 * Refetches on `local:changed` (debounced) and every 5 s while visible.
 */

interface LocalFeedState {
  terminals: any[];
  hosts: any[];
  loaded: boolean;
  refetch: () => Promise<void>;
}

export const useLocalFeedStore = create<LocalFeedState>((set) => ({
  terminals: [],
  hosts: [],
  loaded: false,
  refetch: async () => {
    try {
      const [t, h] = await Promise.all([api.listLocalTerminals(), api.listLocalHosts()]);
      set({ terminals: t.terminals, hosts: h.hosts, loaded: true });
    } catch {
      // transient — the poll retries
    }
  },
}));

let subscribers = 0;
let stop: (() => void) | null = null;

function start() {
  const refetch = () => useLocalFeedStore.getState().refetch();
  refetch();
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const client = createEventsClient(getWsTokenProvider());
  const off = client.on("local:changed", () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(refetch, 400);
  });
  client.connect();
  const interval = setInterval(() => {
    if (document.visibilityState === "visible") refetch();
  }, 5000);
  return () => {
    if (debounce) clearTimeout(debounce);
    off();
    client.disconnect();
    clearInterval(interval);
  };
}

/** Keep the feed running while the calling component is mounted. */
export function useLocalFeed(): LocalFeedState {
  useEffect(() => {
    if (subscribers++ === 0) stop = start();
    return () => {
      if (--subscribers === 0) {
        stop?.();
        stop = null;
      }
    };
  }, []);
  return useLocalFeedStore();
}
