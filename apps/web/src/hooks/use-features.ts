"use client";

import { useEffect } from "react";
import { create } from "zustand";
// The subpath, not "@optio/shared": a test's partial mock of the package
// never breaks the store's birth.
import {
  featuresFromEnv,
  normalizeFeatures,
  type DeploymentFeatures,
} from "@optio/shared/features";
import { api } from "@/lib/api-client";

/**
 * What this deployment offers (packages/shared/src/config/features.ts,
 * docs/feature-lists.md), fetched once per page load from
 * `GET /api/features` and shared by everything that hides a control a
 * feature list leaves out: the runtime, trigger and ticket-source pickers,
 * the git platforms and the connection gallery.
 *
 *   const { features, loaded } = useFeatures();
 *
 * Until the answer arrives the features are what the server layout injected
 * (`window.__OPTIO_CONFIG.features`, synchronous), so a narrowed deployment
 * never flashes what it leaves out; with nothing injected, everything.
 */

interface FeaturesState {
  features: DeploymentFeatures;
  /** The first fetch has settled (successfully or not). */
  loaded: boolean;
  load: () => Promise<void>;
  /** Forget the cached answer (tests). */
  reset: () => void;
}

/** What the server layout injected, if anything (`window.__OPTIO_CONFIG.features`). */
function injectedFeatures(): DeploymentFeatures {
  if (typeof window === "undefined") return featuresFromEnv(process.env);
  const config = (window as any).__OPTIO_CONFIG as { features?: unknown } | undefined;
  return normalizeFeatures(config?.features);
}

let inflight: Promise<void> | null = null;

export const useFeaturesStore = create<FeaturesState>((set) => ({
  features: injectedFeatures(),
  loaded: false,
  load: () => {
    if (inflight) return inflight;
    // `Promise.resolve().then` turns a client without `getFeatures` (a
    // test's partial mock) into the same "keep what was injected" answer as
    // a failed request (signed out: the route needs a session).
    inflight = Promise.resolve()
      .then(() => api.getFeatures())
      .then((res) => set({ features: normalizeFeatures(res), loaded: true }))
      .catch(() => set({ loaded: true }))
      .finally(() => {
        inflight = null;
      });
    return inflight;
  },
  reset: () => {
    inflight = null;
    set({ features: injectedFeatures(), loaded: false });
  },
}));

export interface FeaturesView {
  features: DeploymentFeatures;
  loaded: boolean;
}

export function useFeatures(): FeaturesView {
  const features = useFeaturesStore((s) => s.features);
  const loaded = useFeaturesStore((s) => s.loaded);
  const load = useFeaturesStore((s) => s.load);
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  return { features, loaded };
}
