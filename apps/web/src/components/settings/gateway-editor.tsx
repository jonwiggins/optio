"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, PlugZap, RefreshCw, Star } from "lucide-react";
import {
  MODEL_GATEWAY_TYPES,
  MODEL_GATEWAY_TYPE_INFO,
  MODEL_PROVIDER_AUTH_HEADERS,
  MODEL_PROVIDER_TOKEN_SOURCES,
  modelGatewayTypeInfo,
  type ModelGatewayType,
  type ModelProvider,
  type ModelProviderModel,
} from "@optio/shared";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useGatewayStore } from "@/hooks/use-gateway";
import { Segmented } from "@/components/ui/segmented";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { GatewayCatalogTable } from "./gateway-catalog-table";
import {
  AGENT_LABELS,
  AUTH_HEADER_LABELS,
  TOKEN_SOURCE_LABELS,
  type ProviderForm,
} from "./model-provider-form";

const INPUT = inputClass();
const LABEL = "block text-xs text-text-muted mb-1";

/** What each gateway type is, for the type picker's hint. */
const TYPE_HINTS: Record<ModelGatewayType, string> = {
  generic:
    "Any endpoint that speaks the Anthropic and OpenAI APIs: a base URL and a token; the catalog from /v1/models.",
  litellm: "A LiteLLM proxy: the catalog with context windows and prices, and each token's budget.",
};

/**
 * The gateway's type (model-gateways.ts), which decides what Settings
 * offers for it. Picking a hosted one fills its public base URL while the
 * field is empty or still holds the last type's.
 */
export function GatewayTypeField({
  value,
  baseUrl,
  onChange,
  disabled = false,
}: {
  value: ModelGatewayType | undefined;
  baseUrl: string;
  onChange: (patch: { gatewayType: ModelGatewayType; baseUrl?: string }) => void;
  disabled?: boolean;
}) {
  const current = modelGatewayTypeInfo(value);
  const hosted = (_t: ModelGatewayType) => false;
  return (
    <div>
      <label className={LABEL} htmlFor="gateway-type">
        Type
      </label>
      <select
        id="gateway-type"
        value={current.type}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value as ModelGatewayType;
          const prefilled =
            !baseUrl.trim() || (hosted(current.type) && baseUrl === current.baseUrlExample);
          onChange({
            gatewayType: next,
            ...(prefilled
              ? { baseUrl: hosted(next) ? MODEL_GATEWAY_TYPE_INFO[next].baseUrlExample : "" }
              : {}),
          });
        }}
        className={INPUT}
        data-testid="gateway-type"
      >
        {MODEL_GATEWAY_TYPES.map((t) => (
          <option key={t} value={t}>
            {MODEL_GATEWAY_TYPE_INFO[t].label}
          </option>
        ))}
      </select>
      <p className="text-[11px] text-text-muted mt-1">{TYPE_HINTS[current.type]}</p>
    </div>
  );
}

/**
 * The gateway kind's part of Settings → Model gateway (docs/model-gateway.md):
 * what it is, where it listens and how it takes the token, whose token a run
 * gets, where its management API answers, and the catalog itself as a table
 * per agent. The Sync and Test buttons need a saved gateway (they are its
 * routes), so a new one shows them after its first save.
 */
export function GatewayFields({
  form,
  set,
  original,
  isAdmin,
}: {
  form: ProviderForm;
  set: (patch: Partial<ProviderForm>) => void;
  /** The saved gateway being edited, or null for a new one. */
  original: ModelProvider | null;
  isAdmin: boolean;
}) {
  const creating = original === null;
  const storesToken = form.tokenSource === "stored";
  const sameStored =
    !!original?.hasPodCredentials && original.podCredential === "bearer-token" && storesToken;
  const showTokenField = storesToken && (creating || form.credentialAction === "replace");
  const typeInfo = modelGatewayTypeInfo(form.gatewayType);

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <GatewayTypeField
            value={form.gatewayType}
            baseUrl={form.baseUrl}
            onChange={(patch) => set(patch)}
          />
        </div>
        <div>
          <label className={LABEL}>Base URL</label>
          <input
            value={form.baseUrl}
            onChange={(e) => set({ baseUrl: e.target.value })}
            placeholder={typeInfo.baseUrlExample}
            autoComplete="off"
            className={cn(INPUT, "font-mono")}
          />
          <p className="text-[11px] text-text-muted mt-1">
            Anthropic-compatible for Claude Code; OpenCode takes <code>/v1</code> under it.
          </p>
        </div>
        {typeInfo.syncUrlLabel && (
          <div>
            <label className={LABEL}>{typeInfo.syncUrlLabel} (optional)</label>
            <input
              value={form.syncUrl}
              onChange={(e) => set({ syncUrl: e.target.value })}
              placeholder="Blank = the base URL"
              autoComplete="off"
              className={cn(INPUT, "font-mono")}
            />
            <p className="text-[11px] text-text-muted mt-1">{typeInfo.syncUrlHint}</p>
          </div>
        )}
        <div>
          <label className={LABEL}>Auth header</label>
          <Segmented
            value={form.authHeader}
            onChange={(authHeader) => set({ authHeader })}
            options={MODEL_PROVIDER_AUTH_HEADERS.map((h) => ({
              value: h,
              label: AUTH_HEADER_LABELS[h],
            }))}
          />
          <p className="text-[11px] text-text-muted mt-1.5">
            {form.authHeader === "api-key"
              ? "x-api-key — Claude Code gets the token as ANTHROPIC_API_KEY."
              : "Authorization: Bearer — Claude Code gets the token as ANTHROPIC_AUTH_TOKEN."}
            {form.agents.includes("opencode") && " OpenCode gets it as OPENAI_API_KEY."}
          </p>
        </div>
        <div>
          <label className={LABEL}>Token</label>
          <Segmented
            value={form.tokenSource}
            onChange={(tokenSource) =>
              set({
                tokenSource,
                credentialAction:
                  original?.hasPodCredentials && tokenSource === "stored" ? "keep" : "replace",
              })
            }
            options={MODEL_PROVIDER_TOKEN_SOURCES.map((t) => ({
              value: t,
              label: TOKEN_SOURCE_LABELS[t],
            }))}
          />
          <p className="text-[11px] text-text-muted mt-1.5">
            {storesToken
              ? "One token sealed here for every run (a lab). Stored encrypted; never shown again."
              : "Each run uses its owner's own token (Settings → My tokens; the organization's for its own work), so the gateway's spend stays per person."}
          </p>
          {storesToken && sameStored && form.credentialAction !== "replace" && (
            <div className="flex items-center gap-2 mt-2 text-xs">
              <span className={form.credentialAction === "clear" ? "text-warning" : "text-success"}>
                {form.credentialAction === "clear" ? "Will be cleared" : "Stored"}
              </span>
              <button
                type="button"
                onClick={() => set({ credentialAction: "replace" })}
                className="text-primary hover:underline"
              >
                Replace
              </button>
              {form.credentialAction === "keep" ? (
                <button
                  type="button"
                  onClick={() => set({ credentialAction: "clear" })}
                  className="text-text-muted hover:text-error"
                >
                  Clear
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => set({ credentialAction: "keep" })}
                  className="text-text-muted hover:text-text"
                >
                  Keep
                </button>
              )}
            </div>
          )}
          {showTokenField && (
            <div className="space-y-2 mt-2">
              <input
                type="password"
                value={form.bearerToken}
                onChange={(e) => set({ bearerToken: e.target.value })}
                placeholder="The shared token"
                autoComplete="off"
                className={INPUT}
              />
              {sameStored && (
                <button
                  type="button"
                  onClick={() => set({ credentialAction: "keep" })}
                  className="text-xs text-text-muted hover:text-text"
                >
                  Keep the stored one
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {original && (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-border/50">
          <p className="text-xs text-text-muted">
            Sync reads the gateway&apos;s models and limits into the tables below (your names,
            efforts and roles stay); Test tries your token against it.
          </p>
          <GatewayActions
            provider={original}
            isAdmin={isAdmin}
            onSynced={(p) =>
              set({
                models: Object.fromEntries(
                  Object.entries(p.models).map(([k, v]) => [
                    k,
                    ((v as ModelProviderModel[] | undefined) ?? []).map((m) => ({ ...m })),
                  ]),
                ),
              })
            }
          />
        </div>
      )}

      {form.agents.map((a) => (
        <div key={a} className="pt-3 border-t border-border/50">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
            <label className="text-xs text-text-muted">
              {AGENT_LABELS[a]} catalog{" "}
              <span className="text-text-muted/60">(the first model is the default)</span>
            </label>
          </div>
          <GatewayCatalogTable
            models={form.models[a] ?? []}
            onChange={(models) => set({ models: { ...form.models, [a]: models } })}
            efforts={a === "claude-code"}
          />
        </div>
      ))}
      {creating && (
        <p className="text-[11px] text-text-muted">
          Save first, then Sync reads the catalog from the gateway and Test tries a token.
        </p>
      )}
    </>
  );
}

/**
 * Sync the catalog (admins), Test, and Make default (admins) for a saved
 * gateway — in its list row and above its catalog in the editor. Sync
 * answers with the merged provider (`onSynced`); Make default reloads the
 * shared gateway status so the chip moves.
 */
export function GatewayActions({
  provider,
  isAdmin,
  isDefault = false,
  onSynced,
  onDefault,
}: {
  provider: ModelProvider;
  isAdmin: boolean;
  /** Offer "Make default" (list rows): whether it already is. */
  isDefault?: boolean;
  onSynced?: (provider: ModelProvider) => void;
  /** Offer "Make default" at all. */
  onDefault?: () => void;
}) {
  const [busy, setBusy] = useState<"sync" | "test" | "default" | null>(null);

  const sync = async () => {
    setBusy("sync");
    try {
      const res = await api.syncModelGateway(provider.id);
      toast.success(
        `Synced ${res.synced.models} model${res.synced.models === 1 ? "" : "s"}` +
          (res.synced.missing ? ` · ${res.synced.missing} missing` : ""),
      );
      onSynced?.(res.provider);
    } catch (err) {
      toast.error("Couldn't sync the catalog", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    try {
      const res = await api.testModelGateway(provider.id);
      if (res.ok) {
        toast.success(`${provider.name} answers`, {
          description: `${res.modelCount} model${res.modelCount === 1 ? "" : "s"} with ${
            res.tokenFrom === "stored" ? "the stored token" : "your token"
          }`,
        });
      } else {
        toast.error(`${provider.name} didn't answer`, { description: res.error });
      }
    } catch (err) {
      toast.error("Couldn't test it", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  const makeDefault = async () => {
    if (!provider.workspaceId) return;
    setBusy("default");
    try {
      await api.setDefaultGateway(provider.workspaceId, provider.id);
      toast.success(`${provider.name} is the default gateway`);
      await useGatewayStore.getState().reload();
      onDefault?.();
    } catch (err) {
      toast.error("Couldn't make it the default", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {isAdmin && (
        <Button variant="ghost" size="sm" onClick={sync} disabled={busy !== null}>
          {busy === "sync" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Sync catalog
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={test} disabled={busy !== null}>
        {busy === "test" ? <Loader2 className="animate-spin" /> : <PlugZap />}
        Test
      </Button>
      {isAdmin && onDefault && !isDefault && provider.ownerUserId === null && (
        <Button variant="ghost" size="sm" onClick={makeDefault} disabled={busy !== null}>
          {busy === "default" ? <Loader2 className="animate-spin" /> : <Star />}
          Make default
        </Button>
      )}
    </div>
  );
}
