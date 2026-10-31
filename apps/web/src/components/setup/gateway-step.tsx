"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, CheckCircle, Loader2, Server } from "lucide-react";
import { toast } from "sonner";
import {
  MODEL_PROVIDER_AGENTS,
  modelGatewayTypeInfo,
  normalizeGatewayBaseUrl,
  featureFilter,
  type ModelGatewayType,
  type ModelProvider,
  type ModelProviderAgent,
  type ModelProviderAuthHeader,
} from "@optio/shared";
import { api, type GatewayTestResult } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useGateway } from "@/hooks/use-gateway";
import { useFeatures } from "@/hooks/use-features";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { GatewayActions, GatewayTypeField } from "@/components/settings/gateway-editor";
import { GatewayTokenField, TokenChip, testLine } from "@/components/settings/gateway-token-field";
import { DEFAULT_GATEWAY_NAME, validateGatewayFields } from "@/components/settings/gateway-form";
import { AUTH_HEADER_LABELS } from "@/components/settings/model-provider-form";

const LABEL = "block text-xs text-text-muted mb-1";

/**
 * The setup wizard's "Model gateway" step, which stands in for the
 * agent-credentials step under the restricted deployment (docs/model-gateway.md):
 * what the organization's gateway is and where it listens, how it takes the token, the
 * admin's own token — then Create makes it the organization's and the
 * workspace's default, stores the token, syncs the catalog and tests the
 * connection. A gateway that already exists shows as done, with the token
 * field and Sync / Test for it.
 */
export function GatewayStep({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const { user, isAdmin, loaded: userLoaded } = useCurrentUser();
  const { features } = useFeatures();
  const { status, loaded: statusLoaded, reload } = useGateway();
  const agents = featureFilter("runtimes", MODEL_PROVIDER_AGENTS, features) as ModelProviderAgent[];

  const [existing, setExisting] = useState<ModelProvider | null | undefined>(undefined);
  const [name, setName] = useState(DEFAULT_GATEWAY_NAME);
  const [gatewayType, setGatewayType] = useState<ModelGatewayType | undefined>(undefined);
  const [baseUrl, setBaseUrl] = useState("");
  const [authHeader, setAuthHeader] = useState<ModelProviderAuthHeader>("bearer");
  const [syncUrl, setSyncUrl] = useState("");
  const [token, setToken] = useState("");
  const [creating, setCreating] = useState(false);
  const [test, setTest] = useState<Omit<GatewayTestResult, "tokenFrom"> | null>(null);
  const [synced, setSynced] = useState<{ models: number; missing: number } | null>(null);

  // The organization's gateway, when setup already made one (the default, else the first).
  useEffect(() => {
    api
      .listModelProviders()
      .then((res) => {
        const gateways = (res.providers ?? []).filter(
          (p) => p.kind === "gateway" && p.ownerUserId === null,
        );
        setExisting(gateways.find((p) => p.id === status?.gateway?.id) ?? gateways[0] ?? null);
      })
      .catch(() => setExisting(null));
  }, [status?.gateway?.id]);

  const typeInfo = modelGatewayTypeInfo(gatewayType);
  const error = validateGatewayFields({
    gatewayType,
    baseUrl,
    syncUrl,
    tokenSource: "personal",
    bearerToken: "",
    storesToken: false,
  });
  const canCreate = !error && name.trim().length > 0 && isAdmin && !creating;

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    setTest(null);
    setSynced(null);
    try {
      const { provider } = await api.createModelProvider({
        name: name.trim(),
        owner: "workspace",
        kind: "gateway",
        agents,
        ...(gatewayType ? { gatewayType } : {}),
        baseUrl: normalizeGatewayBaseUrl(baseUrl),
        authHeader,
        syncUrl: normalizeGatewayBaseUrl(syncUrl) || null,
        tokenSource: "personal",
        podCredential: "none",
        models: Object.fromEntries(agents.map((a) => [a, []])),
      });
      const workspaceId = provider.workspaceId ?? user?.workspaceId ?? null;
      if (workspaceId) await api.setDefaultGateway(workspaceId, provider.id);
      let tokenOk = false;
      if (token.trim()) {
        const res = await api.setMyGatewayToken(token.trim(), provider.id);
        setTest(res.test);
        tokenOk = res.test.ok;
        setToken("");
      }
      if (tokenOk && !typeInfo.capabilities.catalogAddsModels) {
        // A gateway that lists hundreds of models adds none on Sync: the
        // admin names the ones they want first.
        toast.info(`Add the models you want to ${provider.name}'s catalog`, {
          description: `${typeInfo.label} serves hundreds; add their ids under Settings → Model gateway, then Sync fills in their limits and prices.`,
        });
        setExisting(provider);
      } else if (tokenOk) {
        // The catalog, read with the token just stored.
        try {
          const res = await api.syncModelGateway(provider.id);
          setSynced(res.synced);
          setExisting(res.provider);
        } catch (err) {
          toast.error("Created, but the catalog sync failed", {
            description: err instanceof Error ? err.message : undefined,
          });
          setExisting(provider);
        }
      } else {
        setExisting(provider);
      }
      toast.success(`${provider.name} is the organization's model gateway`);
      await reload();
    } catch (err) {
      toast.error("Couldn't create the gateway", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setCreating(false);
    }
  };

  const loading = existing === undefined || !statusLoaded || !userLoaded;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Server className="w-6 h-6 text-text" />
        <h2 className="text-lg font-bold">Model gateway</h2>
      </div>
      <p className="text-text-muted text-sm">
        Agents reach their models through the organization&apos;s model gateway: LiteLLM,
        OpenRouter, Portkey or any Anthropic- / OpenAI-compatible endpoint. Each person brings their
        own token for it.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <Loader2 className="w-4 h-4 animate-spin" /> Checking…
        </div>
      ) : existing ? (
        <div
          className="p-4 rounded-md bg-bg border border-border space-y-4"
          data-testid="gateway-existing"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="text-sm font-medium">{existing.name}</span>
              <p className="text-xs text-text-muted font-mono truncate">{existing.baseUrl}</p>
            </div>
            <span className="text-success text-xs flex items-center gap-1 shrink-0">
              <CheckCircle className="w-3 h-3" /> Ready
            </span>
          </div>
          {synced && (
            <p className="text-xs text-text-muted">
              Synced {synced.models} model{synced.models === 1 ? "" : "s"}
              {synced.missing ? ` (${synced.missing} missing)` : ""} from the gateway.
            </p>
          )}
          {test && (
            <p className={cn("text-xs", test.ok ? "text-success" : "text-warning")} role="status">
              {testLine(test)}
            </p>
          )}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-sm">Your token</span>
              <TokenChip hasToken={!!status?.hasToken} />
            </div>
            <GatewayTokenField
              testId="setup-my-token"
              placeholder={
                status?.hasToken ? "Paste a new token to replace it" : "Paste your token"
              }
              onSave={async (t) => (await api.setMyGatewayToken(t)).test}
              onSaved={reload}
            />
          </div>
          <GatewayActions
            provider={existing}
            isAdmin={isAdmin}
            onSynced={(p) => {
              setExisting(p);
              void reload();
            }}
          />
          <p className="text-[11px] text-text-muted">
            Edit the catalog — names, efforts, prices — under Settings → Model gateway.
          </p>
        </div>
      ) : (
        <div
          className="p-4 rounded-md bg-bg border border-border space-y-4"
          data-testid="gateway-form"
        >
          {!isAdmin && (
            <p className="text-xs text-warning">
              The organization&apos;s gateway needs a workspace admin — ask one to run setup, or add
              it under Settings → Model gateway.
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <GatewayTypeField
                value={gatewayType}
                baseUrl={baseUrl}
                authHeader={authHeader}
                onChange={(patch) => {
                  setGatewayType(patch.gatewayType);
                  if (patch.baseUrl !== undefined) setBaseUrl(patch.baseUrl);
                  if (patch.authHeader !== undefined) setAuthHeader(patch.authHeader);
                  if (patch.syncUrl !== undefined) setSyncUrl(patch.syncUrl);
                }}
              />
            </div>
            <div>
              <label className={LABEL}>Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputClass({ className: "bg-bg-card" })}
              />
            </div>
            <div>
              <label className={LABEL}>Base URL</label>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={typeInfo.baseUrlExample}
                autoComplete="off"
                className={inputClass({ className: "bg-bg-card font-mono" })}
              />
            </div>
            <div>
              <label className={LABEL}>Auth header</label>
              <Segmented
                value={authHeader}
                onChange={setAuthHeader}
                options={typeInfo.authHeaders.map((h) => ({
                  value: h,
                  label: AUTH_HEADER_LABELS[h],
                }))}
              />
              <p className="text-[11px] text-text-muted mt-1.5">
                {authHeader === "api-key"
                  ? "x-api-key — Claude Code gets the token as ANTHROPIC_API_KEY."
                  : "Authorization: Bearer — Claude Code gets the token as ANTHROPIC_AUTH_TOKEN."}
              </p>
            </div>
            {typeInfo.syncUrlLabel && (
              <div>
                <label className={LABEL}>{typeInfo.syncUrlLabel} (optional)</label>
                <input
                  value={syncUrl}
                  onChange={(e) => setSyncUrl(e.target.value)}
                  placeholder="Blank = the base URL"
                  autoComplete="off"
                  className={inputClass({ className: "bg-bg-card font-mono" })}
                />
                <p className="text-[11px] text-text-muted mt-1">{typeInfo.syncUrlHint}</p>
              </div>
            )}
            <div className="sm:col-span-2">
              <label className={LABEL}>Your own token</label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Stored as your private secret; used to sync and test"
                autoComplete="off"
                className={inputClass({ className: "bg-bg-card font-mono" })}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-warning">{baseUrl ? (error ?? "") : ""}</p>
            <Button onClick={create} disabled={!canCreate}>
              {creating ? <Loader2 className="animate-spin" /> : null}
              Create
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft /> Back
        </Button>
        <Button onClick={onDone} disabled={!existing}>
          Continue <ArrowRight />
        </Button>
      </div>
    </div>
  );
}
