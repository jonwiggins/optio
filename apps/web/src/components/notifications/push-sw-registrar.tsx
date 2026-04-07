"use client";

import { useEffect } from "react";
import { registerServiceWorker } from "@/lib/push-subscription";

/**
 * Registers the push notification service worker on mount.
 * Render once in the layout — safe to call multiple times (idempotent).
 */
export function PushSwRegistrar() {
  useEffect(() => {
    registerServiceWorker();
  }, []);

  return null;
}
