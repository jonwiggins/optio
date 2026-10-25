"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Save } from "lucide-react";
import {
  modelGatewayCapabilities,
  modelGatewayTypeInfo,
  type GatewayKeyModes,
  type ModelGatewayType,
} from "@optio/shared";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  gatewayKeysApi,
  type KeyIssuingSettings,
  type SaveKeyIssuing,
} from "@/lib/gateway-keys-api";
import {
  BudgetInputs,
  KEY_LIVES,
  amountOf,
  budgetPeriodsFor,
  withCurrent,
} from "./gateway-budget-inputs";

/**
 * Settings → Model gateway → a gateway → "How people get tokens"
 * (docs/model-gateway.md "Keys Optio makes"; workspace admins, the
 * organization's gateway): pasting, Optio-made keys or both; the gateway's
 * admin key Optio makes keys with (sealed, never shown); and what a new
 * key gets — a person's budget and period, the models where the gateway
 * limits a key's models (none ticked = the whole catalog; a ticked one the
 * catalog stopped serving shows flagged, so it can be unticked), the key's
 * life, and a team's budget (also the most a team admin may set). What the
 * gateway's type lacks isn't offered: a type without managed keys takes
 * pasted tokens only. Saved on its own (`PUT .../key-issuing`), apart from
 * the gateway's Save.
 */

interface Draft {
  modes: GatewayKeyModes;
  adminKey: string;
  clearAdminKey: boolean;
  maxBudget: string;
  budgetDuration: string;
  models: string[];
  keyDuration: string;
  teamMaxBudget: string;
  teamBudgetDuration: string;
  /** Portkey: the workspace keys are made in. */
  workspace: string;
}

const text = (n: number | null) => (n === null ? "" : String(n));

export function draftOf(s: KeyIssuingSettings): Draft {
  return {
    modes: { ...s.modes },
    adminKey: "",
    clearAdminKey: false,
    maxBudget: text(s.defaults.maxBudget),
    budgetDuration: s.defaults.budgetDuration ?? "",
    models: [...s.defaults.models],
    keyDuration: s.defaults.keyDuration ?? "",
    teamMaxBudget: text(s.defaults.teamMaxBudget),
    teamBudgetDuration: s.defaults.teamBudgetDuration ?? "",
    workspace: s.defaults.workspace ?? "",
  };
}

/** The body for `PUT .../key-issuing`, or the reason the draft can't be saved. */
export function bodyOf(d: Draft, type?: ModelGatewayType): SaveKeyIssuing | string {
  if (!d.modes.personalPasted && !d.modes.optioIssued) {
    return "Leave people at least one way to get a token";
  }
  const maxBudget = amountOf(d.maxBudget);
  const teamMaxBudget = amountOf(d.teamMaxBudget);
  if (Number.isNaN(maxBudget) || Number.isNaN(teamMaxBudget)) {
    return "A budget is an amount in USD, like 25";
  }
  const body: SaveKeyIssuing = {
    modes: d.modes,
    defaults: {
      maxBudget,
      budgetDuration: maxBudget === null ? null : d.budgetDuration || null,
      models: d.models,
      keyDuration: d.keyDuration || null,
      teamMaxBudget,
      teamBudgetDuration: teamMaxBudget === null ? null : d.teamBudgetDuration || null,
      ...(type === "portkey" ? { workspace: d.workspace.trim() || null } : {}),
    },
  };
  if (d.clearAdminKey) body.adminKey = null;
  else if (d.adminKey.trim()) body.adminKey = d.adminKey.trim();
  return body;
}

export function GatewayKeyIssuing({
  providerId,
  sharedToken,
}: {
  providerId: string;
  /** The gateway gives every run one stored token: Optio can't make keys for people. */
  sharedToken: boolean;
}) {
  const [settings, setSettings] = useState<KeyIssuingSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [keyTest, setKeyTest] = useState<{ ok: boolean; error?: string } | null>(null);

  useEffect(() => {
    let active = true;
    gatewayKeysApi
      .getKeyIssuing(providerId)
      .then((s) => {
        if (!active) return;
        setSettings(s);
        setDraft(draftOf(s));
      })
      .catch((err) => active && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      active = false;
    };
  }, [providerId]);

  if (error) {
    return (
      <p className="text-xs text-warning">Couldn&apos;t read how people get tokens: {error}</p>
    );
  }
  if (!settings || !draft) {
    return <div className="h-24 skeleton-shimmer rounded-lg" aria-label="Loading token settings" />;
  }

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setMode = (k: keyof GatewayKeyModes, v: boolean) =>
    set({ modes: { ...draft.modes, [k]: v } });
  const toggleModel = (id: string) =>
    set({
      models: draft.models.includes(id)
        ? draft.models.filter((m) => m !== id)
        : [...draft.models, id],
    });

  const type = settings.gatewayType;
  const info = modelGatewayTypeInfo(type);
  const caps = settings.capabilities ?? modelGatewayCapabilities(type);
  const periods = budgetPeriodsFor(type);

  const save = async () => {
    const body = bodyOf(draft, type);
    if (typeof body === "string") {
      toast.error(body);
      return;
    }
    setSaving(true);
    setKeyTest(null);
    try {
      const res = await gatewayKeysApi.saveKeyIssuing(providerId, body);
      setSettings(res.settings);
      setDraft(draftOf(res.settings));
      setKeyTest(res.adminKeyTest);
      if (res.adminKeyTest && !res.adminKeyTest.ok) {
        toast.warning("Saved, but the gateway refused the admin key", {
          description: res.adminKeyTest.error,
        });
      } else {
        toast.success(res.changed.length ? "Token settings saved" : "Nothing changed");
      }
    } catch (err) {
      toast.error("Couldn't save the token settings", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const LABEL = "block text-xs text-text-muted mb-1";
  // The catalog's models, then picks it no longer serves (new keys leave those out).
  const stale = settings.staleModels ?? [];
  const shownModels = [
    ...settings.catalogModels,
    ...stale.filter((m) => !settings.catalogModels.includes(m)),
  ];
  const adminKeyState = draft.clearAdminKey
    ? "Will be cleared"
    : settings.hasAdminKey
      ? "Stored"
      : "Not stored";

  if (!caps.managedKeys) {
    return (
      <div className="space-y-1" data-testid="gateway-key-issuing">
        <p className="text-sm font-medium">How people get tokens</p>
        <p className="text-[11px] text-text-muted">
          People and team admins paste the keys they got from the gateway (Settings → My tokens,
          Teams → a team → Tokens). Optio makes keys itself on gateway types with an admin API
          (LiteLLM, OpenRouter, Portkey).
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="gateway-key-issuing">
      <div>
        <p className="text-sm font-medium">How people get tokens</p>
        <p className="text-[11px] text-text-muted mt-0.5">
          People and team admins can paste keys they got from the gateway, Optio can make the keys
          itself (with a budget{caps.keyModels ? ", the catalog's models" : ""} and an expiry), or
          both — then each person chooses.
        </p>
      </div>

      <div className="space-y-2">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={draft.modes.personalPasted}
            onChange={(e) => setMode("personalPasted", e.target.checked)}
          />
          <span>
            People paste their own keys
            <span className="block text-[11px] text-text-muted">
              Settings → My tokens and Teams → a team → Tokens take a key someone got from the
              gateway.
            </span>
          </span>
        </label>
        <label className={cn("flex items-start gap-2 text-sm", sharedToken && "opacity-60")}>
          <input
            type="checkbox"
            className="mt-0.5"
            checked={draft.modes.optioIssued}
            disabled={sharedToken && !draft.modes.optioIssued}
            onChange={(e) => setMode("optioIssued", e.target.checked)}
            data-testid="mode-optio-issued"
          />
          <span>
            Optio makes the keys
            <span className="block text-[11px] text-text-muted">
              {sharedToken
                ? "Only for a gateway where each run uses its owner's token (Token: per person)."
                : `"Get my token" and "Create team key": Optio makes, rotates and revokes keys on the gateway with the admin key below.`}
            </span>
          </span>
        </label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={LABEL} htmlFor={`${providerId}-admin-key`}>
            {info.adminKeyName ?? "Admin key"}{" "}
            <span
              className={cn(
                "ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium",
                adminKeyState === "Stored"
                  ? "bg-success/10 text-success"
                  : "bg-warning/10 text-warning",
              )}
            >
              {adminKeyState}
            </span>
          </label>
          <div className="flex gap-2">
            <input
              id={`${providerId}-admin-key`}
              type="password"
              value={draft.adminKey}
              onChange={(e) => set({ adminKey: e.target.value, clearAdminKey: false })}
              placeholder={settings.hasAdminKey ? "Paste a new one to replace it" : "sk-…"}
              autoComplete="off"
              className={inputClass({ size: "sm", className: "flex-1 font-mono" })}
            />
            {settings.hasAdminKey && (
              <button
                type="button"
                onClick={() => set({ clearAdminKey: !draft.clearAdminKey, adminKey: "" })}
                className="text-xs text-text-muted hover:text-error"
              >
                {draft.clearAdminKey ? "Keep" : "Clear"}
              </button>
            )}
          </div>
          <p className="text-[11px] text-text-muted mt-1">
            {info.adminKeyHint} Sealed here and never shown; Optio uses it only to make, rotate,
            block and read the keys it makes.
          </p>
          {keyTest && (
            <p
              className={cn("text-[11px] mt-1", keyTest.ok ? "text-success" : "text-warning")}
              role="status"
            >
              {keyTest.ok ? "The gateway takes it." : `The gateway refused it: ${keyTest.error}`}
            </p>
          )}
        </div>
        <div>
          <label className={LABEL} htmlFor={`${providerId}-key-life`}>
            A key lives
          </label>
          <select
            id={`${providerId}-key-life`}
            value={draft.keyDuration}
            onChange={(e) => set({ keyDuration: e.target.value })}
            className={inputClass({ size: "sm", className: "w-auto" })}
          >
            {withCurrent(KEY_LIVES, draft.keyDuration).map((o) => (
              <option key={o.value || "none"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-text-muted mt-1">
            After that the gateway refuses it; the person presses Rotate for a new one.
          </p>
        </div>
        {type === "portkey" && (
          <div>
            <label className={LABEL} htmlFor={`${providerId}-workspace`}>
              Workspace (optional)
            </label>
            <input
              id={`${providerId}-workspace`}
              value={draft.workspace}
              onChange={(e) => set({ workspace: e.target.value })}
              placeholder="The admin key's own"
              autoComplete="off"
              className={inputClass({ size: "sm", className: "font-mono" })}
            />
            <p className="text-[11px] text-text-muted mt-1">
              The Portkey workspace Optio makes keys in.
            </p>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <BudgetInputs
          idPrefix={`${providerId}-person`}
          label="A person's budget"
          amount={draft.maxBudget}
          period={draft.budgetDuration}
          onAmount={(maxBudget) => set({ maxBudget })}
          onPeriod={(budgetDuration) => set({ budgetDuration })}
          periods={periods}
        />
        <BudgetInputs
          idPrefix={`${providerId}-team`}
          label="A team's budget"
          amount={draft.teamMaxBudget}
          period={draft.teamBudgetDuration}
          onAmount={(teamMaxBudget) => set({ teamMaxBudget })}
          onPeriod={(teamBudgetDuration) => set({ teamBudgetDuration })}
          periods={periods}
        />
        <p className="text-[11px] text-text-muted">
          The gateway refuses a key&apos;s calls once its budget is spent, until the period resets.
          A new team key starts with the team&apos;s budget, and a team admin may set up to it (a
          workspace admin, any amount).
          {caps.spend
            ? " Optio emails the owner, or the team's admins, at 80% and 100%."
            : " This gateway doesn't report a key's spend, so its own alerts are the ones to use."}
          {type === "portkey" && " Portkey takes whole USD, 1 or more."}
        </p>
      </div>

      {caps.keyModels && (
        <div>
          <p className={LABEL}>Models a key may call</p>
          {shownModels.length === 0 ? (
            <p className="text-[11px] text-text-muted">
              Sync the catalog first; until then a key may call every model.
            </p>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {shownModels.map((id) => (
                <label key={id} className="flex items-center gap-1.5 text-xs font-mono">
                  <input
                    type="checkbox"
                    checked={draft.models.includes(id)}
                    onChange={() => toggleModel(id)}
                  />
                  {id}
                  {stale.includes(id) && (
                    <span className="font-sans px-1.5 py-0.5 rounded text-[10px] bg-warning/10 text-warning">
                      no longer served
                    </span>
                  )}
                </label>
              ))}
            </div>
          )}
          <p className="text-[11px] text-text-muted mt-1">
            None ticked: every model in the catalog.
            {stale.length > 0 &&
              " A model flagged no longer served is left out of new keys; untick it to tidy up."}
          </p>
        </div>
      )}

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={saving}
          data-testid="save-key-issuing"
        >
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          Save token settings
        </Button>
      </div>
    </div>
  );
}
