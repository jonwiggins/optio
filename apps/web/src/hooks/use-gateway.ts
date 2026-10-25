"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { api, type GatewayMe } from "@/lib/api-client";

/**
 * The viewer's standing with the workspace's default model gateway
 * (`GET /api/gateway/me`; docs/model-gateway.md): which gateway it is,
 * whether they have a token for it, which of their teams do, whether the
 * organization does. Fetched once per page load and shared by Settings →
 * My tokens, the New work form's model picker, the Overview's usage
 * panel and the Model gateway card's "Default gateway" chip; `reload`
 * after a token is saved or the default changes.
 *
 *   const { status, loaded, reload } = useGateway();
 */

interface GatewayState {
  status: GatewayMe | null;
  /** The first fetch has settled (successfully or not). */
  loaded: boolean;
  load: () => Promise<void>;
  reload: () => Promise<void>;
  reset: () => void;
}

let inflight: Promise<void> | null = null;

function fetchStatus(set: (s: Partial<GatewayState>) => void): Promise<void> {
  if (inflight) return inflight;
  inflight = Promise.resolve()
    .then(() => api.getMyGateway())
    .then((status) => set({ status, loaded: true }))
    .catch(() => set({ loaded: true }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export const useGatewayStore = create<GatewayState>((set) => ({
  status: null,
  loaded: false,
  load: () => fetchStatus(set),
  reload: () => {
    inflight = null;
    return fetchStatus(set);
  },
  reset: () => {
    inflight = null;
    set({ status: null, loaded: false });
  },
}));

export function useGateway(): {
  status: GatewayMe | null;
  loaded: boolean;
  reload: () => Promise<void>;
} {
  const status = useGatewayStore((s) => s.status);
  const loaded = useGatewayStore((s) => s.loaded);
  const load = useGatewayStore((s) => s.load);
  const reload = useGatewayStore((s) => s.reload);
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  return { status, loaded, reload };
}
