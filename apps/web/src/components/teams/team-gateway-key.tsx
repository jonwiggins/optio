"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { KeyRound, Loader2, RotateCw, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmPopover } from "@/components/ui/confirm-popover";
import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/utils";
import {
  budgetLine,
  budgetShare,
  gatewayKeysApi,
  type GatewayBudget,
  type TeamGatewayKey,
} from "@/lib/gateway-keys-api";
import {
  BudgetInputs,
  amountOf,
  budgetPeriodsFor,
} from "@/components/settings/gateway-budget-inputs";
import { testLine } from "@/components/settings/gateway-token-field";

/**
 * A team's gateway key made by Optio, and its budget (docs/model-gateway.md
 * "Keys Optio makes"): "Create team key" makes the team's key on the gateway
 * with the budget (on LiteLLM a LiteLLM team and a key bound to it;
 * elsewhere one key whose own limit is the budget), stored as the team's
 * gateway token; the team's admins (and workspace admins) set the budget,
 * rotate and revoke. The gateway itself refuses the team's runs once the
 * budget is spent.
 */

/** `GET /api/gateway/teams/:teamId`, refetched with `reload` (null while loading or on failure). */
export function useTeamGatewayKey(teamId: string): {
  teamKey: TeamGatewayKey | null;
  reload: () => Promise<void>;
} {
  const [teamKey, setTeamKey] = useState<TeamGatewayKey | null>(null);
  const reload = useCallback(async () => {
    try {
      setTeamKey(await gatewayKeysApi.getTeamKey(teamId));
    } catch {
      setTeamKey(null);
    }
  }, [teamId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { teamKey, reload };
}

/** A budget bar with its line: amber from 80%, red when spent. */
export function BudgetMeter({ budget, testId }: { budget: GatewayBudget; testId?: string }) {
  const share = budgetShare(budget);
  return (
    <div className="space-y-1" data-testid={testId}>
      {share !== null && (
        <div className="h-1.5 rounded-full bg-bg-hover overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full",
              share >= 1 ? "bg-error" : share >= 0.8 ? "bg-warning" : "bg-primary/60",
            )}
            style={{ width: `${Math.min(100, share * 100)}%` }}
          />
        </div>
      )}
      <p className="text-[11px] text-text-muted">
        {budgetLine(budget)}
        {budget.source === "saved" && budget.spend !== null ? " (at Optio's last check)" : ""}
      </p>
    </div>
  );
}

export function TeamGatewayKey({
  teamKey,
  onChanged,
}: {
  teamKey: TeamGatewayKey;
  /** After a key is made, rotated or revoked, or the budget set. */
  onChanged: () => void | Promise<void>;
}) {
  const { issued, canIssue, canManage, budgetCap, team } = teamKey;
  const start = issued ? (teamKey.budget ?? null) : null;
  const [amount, setAmount] = useState(() => {
    const v = issued ? (start?.maxBudget ?? issued.maxBudget) : teamKey.defaults.maxBudget;
    return v === null || v === undefined ? "" : String(v);
  });
  const [period, setPeriod] = useState(
    () =>
      (issued
        ? (start?.budgetDuration ?? issued.budgetDuration)
        : teamKey.defaults.budgetDuration) ?? "30d",
  );
  const [busy, setBusy] = useState<"create" | "budget" | "rotate" | "revoke" | null>(null);
  const [asking, setAsking] = useState<"rotate" | "revoke" | null>(null);
  const [lastTest, setLastTest] = useState<string | null>(null);

  const budgetInput = () => {
    const maxBudget = amountOf(amount);
    if (Number.isNaN(maxBudget)) throw new Error("The budget is an amount in USD, like 50");
    return { maxBudget, budgetDuration: maxBudget === null ? null : period || null };
  };

  const act = async (what: "create" | "budget" | "rotate" | "revoke") => {
    setAsking(null);
    setBusy(what);
    setLastTest(null);
    try {
      if (what === "revoke") {
        await gatewayKeysApi.revokeTeamKey(team.id);
        toast.success(`${team.name}'s key is deleted in the gateway`);
      } else if (what === "budget") {
        await gatewayKeysApi.setTeamBudget(team.id, budgetInput());
        toast.success(`${team.name}'s budget is set`);
      } else {
        const res = await gatewayKeysApi.createTeamKey(
          team.id,
          what === "create" ? budgetInput() : {},
        );
        setLastTest(testLine(res.test));
        if (res.test.ok) toast.success(what === "rotate" ? "New team key ready" : "Team key ready");
        else toast.warning("Stored, but the gateway refused it", { description: res.test.error });
      }
      await onChanged();
    } catch (err) {
      toast.error(
        what === "budget"
          ? "Couldn't set the budget"
          : what === "revoke"
            ? "Couldn't revoke the key"
            : "Couldn't make the team's key",
        { description: err instanceof Error ? err.message : undefined },
      );
    } finally {
      setBusy(null);
    }
  };

  const capLine =
    budgetCap !== null ? `A team admin may set up to $${budgetCap.toFixed(2)}.` : null;

  if (!issued) {
    if (!teamKey.modes.optioIssued) return null;
    if (!canManage) return null;
    return (
      <div className="space-y-2" data-testid="team-key-create">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Team key made by Optio</span>
        </div>
        {canIssue ? (
          <>
            <p className="text-[11px] text-text-muted">
              Optio makes the team a key in the gateway with this budget, stored as the team&apos;s
              token. The gateway refuses the team&apos;s runs once the budget is spent. {capLine}
              {teamKey.hasToken ? " It replaces the token stored now." : ""}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <BudgetInputs
                idPrefix={`team-${team.id}`}
                amount={amount}
                period={period}
                onAmount={setAmount}
                onPeriod={setPeriod}
                label="Team budget"
                disabled={busy !== null}
                periods={budgetPeriodsFor(teamKey.gateway?.type)}
              />
              <Button
                size="sm"
                onClick={() => void act("create")}
                disabled={busy !== null}
                data-testid="create-team-key"
              >
                {busy === "create" ? <Loader2 className="animate-spin" /> : <KeyRound />}
                Create team key
              </Button>
            </div>
          </>
        ) : (
          <p className="text-[11px] text-text-muted">
            An admin hasn&apos;t finished setting up the gateway&apos;s keys yet (Settings → Model
            gateway).
          </p>
        )}
        {lastTest && (
          <p className="text-[11px] text-text-muted" role="status">
            {lastTest}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="team-issued-key">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-xs">
          <span className="text-sm font-medium mr-2">Team key made by Optio</span>
          <span className="font-mono">{issued.keyAlias ?? "key"}</span>
          {issued.keyHint && <span className="font-mono text-text-muted"> …{issued.keyHint}</span>}
          {issued.expiresAt && (
            <span className="text-text-muted">
              {" "}
              · expires {new Date(issued.expiresAt).toLocaleDateString()}
            </span>
          )}
        </div>
        {canManage && (
          <div className="flex items-center gap-1">
            {canIssue && (
              <ConfirmPopover
                open={asking === "rotate"}
                title="Rotate the team's key?"
                detail={
                  teamKey.gateway?.type === "portkey"
                    ? "The gateway gives the team's key a new value; it keeps its budget. The old value keeps working for 30 minutes, then stops."
                    : "Optio makes a new key with the same budget and deletes this one. Team runs going now stop at their next model call."
                }
                confirmLabel="Rotate"
                busy={busy === "rotate"}
                onConfirm={() => void act("rotate")}
                onCancel={() => setAsking(null)}
              >
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setAsking("rotate")}
                  disabled={busy !== null}
                >
                  {busy === "rotate" ? <Loader2 className="animate-spin" /> : <RotateCw />}
                  Rotate
                </Button>
              </ConfirmPopover>
            )}
            <ConfirmPopover
              open={asking === "revoke"}
              title="Revoke the team's key?"
              detail="It is deleted in the gateway and removed from the team's tokens; the team's runs fail until it gets another. Its spend stays in the gateway."
              confirmLabel="Revoke"
              busy={busy === "revoke"}
              onConfirm={() => void act("revoke")}
              onCancel={() => setAsking(null)}
            >
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setAsking("revoke")}
                disabled={busy !== null}
              >
                {busy === "revoke" ? <Loader2 className="animate-spin" /> : <Trash2 />}
                Revoke
              </Button>
            </ConfirmPopover>
          </div>
        )}
      </div>
      {teamKey.budget && <BudgetMeter budget={teamKey.budget} testId="team-budget" />}
      {canManage && (
        <div className="flex flex-wrap items-center gap-3">
          <BudgetInputs
            idPrefix={`team-${team.id}`}
            amount={amount}
            period={period}
            onAmount={setAmount}
            onPeriod={setPeriod}
            label="Team budget"
            disabled={busy !== null}
            periods={budgetPeriodsFor(teamKey.gateway?.type)}
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void act("budget")}
            disabled={busy !== null}
            data-testid="set-team-budget"
          >
            {busy === "budget" ? <Loader2 className="animate-spin" /> : <Save />}
            Set budget
          </Button>
          {capLine && <span className="text-[11px] text-text-muted">{capLine}</span>}
        </div>
      )}
      {lastTest && (
        <p className="text-[11px] text-text-muted" role="status">
          {lastTest}
        </p>
      )}
    </div>
  );
}

/**
 * For a team's members who don't manage it: the team's gateway budget, read
 * only, when Optio made the team's key (nothing otherwise).
 */
export function TeamGatewayBudgetCard({ teamId }: { teamId: string }) {
  const { teamKey } = useTeamGatewayKey(teamId);
  if (!teamKey?.issued || !teamKey.budget) return null;
  return (
    <Panel title="Gateway budget">
      <div className="p-4 space-y-2">
        <p className="text-xs text-text-muted">
          The team&apos;s work runs with a key Optio made in{" "}
          {teamKey.gateway?.name ?? "the gateway"}; the gateway refuses the team&apos;s runs once
          this budget is spent.
        </p>
        <BudgetMeter budget={teamKey.budget} testId="team-budget" />
      </div>
    </Panel>
  );
}
