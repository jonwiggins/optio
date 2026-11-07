"use client";

import { useEffect, useState } from "react";
import { isModelProviderAgent, type ModelProvider, type ModelProviderModel } from "@optio/shared";
import { api } from "@/lib/api-client";
import { useGatewayStore } from "@/hooks/use-gateway";

/**
 * The model gateway a picker with no gateway of its own offers the catalog
 * of (docs/model-gateway.md) — a repo's default agent, a review agent: the
 * workspace's default gateway (`GET /api/gateway/me`), else the
 * organization's first that serves the runtime, the way the New work form
 * (work-form/gateway.ts `gatewayFor`) and the server stand one in.
 *
 *   const { gateway, models } = useDefaultGateway(runtime, gatewayOnly && !props.gateway);
 *
 * Off (`enabled` false, unrestricted model access), it fetches nothing and answers
 * nothing, so the pickers are untouched.
 */

let providersOnce: Promise<ModelProvider[]> | null = null;

function loadProviders(): Promise<ModelProvider[]> {
  if (!providersOnce) {
    // `Promise.resolve().then` turns a client without `listModelProviders`
    // (a test's partial mock) into "no gateways" like a failed request.
    providersOnce = Promise.resolve()
      .then(() => api.listModelProviders())
      .then((res) => res.providers ?? [])
      .catch(() => {
        providersOnce = null;
        return [];
      });
  }
  return providersOnce;
}

/** Forget the cached providers (tests). */
export function resetDefaultGatewayCache(): void {
  providersOnce = null;
}

/** The gateway `runtime` runs through when nothing names one (pure; tested). */
export function defaultGatewayFor(
  runtime: string,
  providers: ModelProvider[],
  defaultGatewayId: string | null,
): ModelProvider | null {
  if (!isModelProviderAgent(runtime)) return null;
  const choices = providers.filter(
    (p) => p.kind === "gateway" && p.agents.includes(runtime) && (p.ownerUserId === null || p.mine),
  );
  return (
    choices.find((p) => p.id === defaultGatewayId) ??
    choices.find((p) => p.ownerUserId === null) ??
    null
  );
}

export function useDefaultGateway(
  runtime: string,
  enabled: boolean,
): { gateway?: { id: string; name: string }; models?: ModelProviderModel[] } {
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  // The store, not `useGateway()`: unrestricted model access never fetches it here.
  const status = useGatewayStore((s) => s.status);
  const statusLoaded = useGatewayStore((s) => s.loaded);
  const loadStatus = useGatewayStore((s) => s.load);
  useEffect(() => {
    if (enabled && !statusLoaded) void loadStatus();
  }, [enabled, statusLoaded, loadStatus]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void loadProviders().then((list) => {
      if (live) setProviders(list);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  if (!enabled) return {};
  const gateway = defaultGatewayFor(runtime, providers, status?.gateway?.id ?? null);
  if (!gateway || !isModelProviderAgent(runtime)) return {};
  return {
    gateway: { id: gateway.id, name: gateway.name },
    models: gateway.models[runtime] ?? [],
  };
}
