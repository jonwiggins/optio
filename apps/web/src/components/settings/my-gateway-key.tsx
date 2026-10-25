"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { KeyRound, Loader2, RotateCw, Trash2 } from "lucide-react";
import { modelGatewayCapabilities, type ModelGatewayType } from "@optio/shared";
import { Button } from "@/components/ui/button";
import { ConfirmPopover } from "@/components/ui/confirm-popover";
import { gatewayKeysApi, budgetLine, type MyGatewayKey } from "@/lib/gateway-keys-api";
import { GatewayTokenField, TokenChip, testLine } from "./gateway-token-field";
import { api } from "@/lib/api-client";

/**
 * The viewer's own gateway token in Settings → My tokens, in the ways the
 * default gateway allows (docs/model-gateway.md "Keys Optio makes"):
 *
 * - **Get my token** when the gateway has Optio make keys: the gateway makes
 *   a key for them with its budget (and models, where it limits them),
 *   stored where a pasted token goes. Then Rotate (a new key, the old one
 *   deleted on the gateway; Portkey gives the same key a new value) and
 *   Give up.
 * - **Paste** when the gateway takes pasted keys (what it always did).
 *
 * With both on, the person chooses; Get my token replaces a pasted token.
 */

/** `GET /api/gateway/me/key`, refetched with `reload` (null until it answers, or when it failed). */
export function useMyGatewayKey(): {
  keyStatus: MyGatewayKey | null;
  reload: () => Promise<void>;
} {
  const [keyStatus, setKeyStatus] = useState<MyGatewayKey | null>(null);
  const reload = useCallback(async () => {
    try {
      setKeyStatus(await gatewayKeysApi.getMyKey());
    } catch {
      setKeyStatus(null);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { keyStatus, reload };
}

/** What a key Optio makes gets: "a budget of $5.00 per 30d, all catalog models, no expiry". */
export function keyTermsLine(d: MyGatewayKey["defaults"]): string {
  const budget =
    d.maxBudget !== null
      ? `a budget of $${d.maxBudget.toFixed(2)}${d.budgetDuration ? ` per ${d.budgetDuration}` : ""}`
      : "no budget cap";
  const life = d.keyDuration ? `valid for ${d.keyDuration}` : "no expiry";
  return `${budget}, ${life}`;
}

/**
 * A key's budget line: what it spent of what, where the gateway reports a
 * key's spend; else only the budget (a gateway that doesn't report spend).
 */
export function issuedBudgetLine(
  issued: NonNullable<MyGatewayKey["issued"]>,
  type: ModelGatewayType | null | undefined,
): string {
  if (modelGatewayCapabilities(type).spend) {
    return budgetLine({
      spend: issued.spendUsd,
      maxBudget: issued.maxBudget,
      budgetDuration: issued.budgetDuration,
      budgetResetAt: issued.budgetResetAt,
    });
  }
  if (issued.maxBudget === null) return "No budget cap";
  return `Budget $${issued.maxBudget.toFixed(2)}${issued.budgetDuration ? ` per ${issued.budgetDuration}` : ""}`;
}

/** What Rotate does on the gateway's type, for the confirmation. */
function rotateDetail(type: ModelGatewayType | null | undefined): string {
  return type === "portkey"
    ? "The gateway gives your key a new value; it keeps its budget and what it spent. The old value keeps working for 30 minutes, then stops."
    : "Optio makes a new key, which keeps what this one spent this budget period, and deletes this one in the gateway. Runs going now with the old key stop at their next model call.";
}

export function PersonalGatewayToken({
  keyStatus,
  hasToken,
  usageLine,
  onChanged,
}: {
  /** `GET /api/gateway/me/key`; null while loading or when it failed (pasting stays). */
  keyStatus: MyGatewayKey | null;
  hasToken: boolean;
  /** The gateway's budget for the stored token, from `GET /api/gateway/me`. */
  usageLine: string | null;
  /** After a token is made, rotated, given up or pasted. */
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<"issue" | "rotate" | "revoke" | null>(null);
  const [asking, setAsking] = useState<"rotate" | "revoke" | null>(null);
  const [lastTest, setLastTest] = useState<string | null>(null);

  // Unknown modes (the call failed): pasting, as before.
  const pasting = keyStatus?.modes.personalPasted ?? true;
  const issuing = keyStatus?.modes.optioIssued ?? false;
  const issued = keyStatus?.issued ?? null;

  const run = async (what: "issue" | "rotate" | "revoke") => {
    setAsking(null);
    setBusy(what);
    setLastTest(null);
    try {
      if (what === "revoke") {
        await gatewayKeysApi.revokeMyKey();
        toast.success("Your key is deleted in the gateway");
      } else {
        const res =
          what === "rotate"
            ? await gatewayKeysApi.rotateMyKey()
            : await gatewayKeysApi.issueMyKey();
        setLastTest(testLine(res.test));
        if (res.test.ok) {
          toast.success(what === "rotate" ? "Your new token is ready" : "Your token is ready", {
            description: `${res.key.keyAlias ?? "Key"} …${res.key.keyHint ?? ""}`,
          });
        } else {
          toast.warning("Your token is stored, but the gateway refused it", {
            description: res.test.error,
          });
        }
      }
      await onChanged();
    } catch (err) {
      toast.error(
        what === "revoke"
          ? "Couldn't give up the key"
          : what === "rotate"
            ? "Couldn't rotate the key"
            : "Couldn't get a token",
        { description: err instanceof Error ? err.message : undefined },
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2" data-testid="personal-gateway-token">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Your token</span>
        <TokenChip hasToken={hasToken} />
        {issued && (
          <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-medium">
            Made by Optio
          </span>
        )}
        {usageLine && <span className="text-[11px] text-text-muted">{usageLine}</span>}
      </div>

      {issued && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2"
          data-testid="my-issued-key"
        >
          <div className="min-w-0 text-xs">
            <span className="font-mono">{issued.keyAlias ?? "key"}</span>
            {issued.keyHint && (
              <span className="font-mono text-text-muted"> …{issued.keyHint}</span>
            )}
            <span className="block text-[11px] text-text-muted mt-0.5">
              {issuedBudgetLine(issued, keyStatus?.gateway?.type)}
              {issued.expiresAt
                ? ` · expires ${new Date(issued.expiresAt).toLocaleDateString()}`
                : ""}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {keyStatus?.canIssue && (
              <ConfirmPopover
                open={asking === "rotate"}
                title="Rotate your key?"
                detail={rotateDetail(keyStatus?.gateway?.type)}
                confirmLabel="Rotate"
                busy={busy === "rotate"}
                onConfirm={() => void run("rotate")}
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
              title="Give up your key?"
              detail="It is deleted in the gateway and removed from your tokens; your runs fail until you get or paste another."
              confirmLabel="Give it up"
              busy={busy === "revoke"}
              onConfirm={() => void run("revoke")}
              onCancel={() => setAsking(null)}
            >
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setAsking("revoke")}
                disabled={busy !== null}
              >
                {busy === "revoke" ? <Loader2 className="animate-spin" /> : <Trash2 />}
                Give up
              </Button>
            </ConfirmPopover>
          </div>
        </div>
      )}

      {!issued && issuing && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            onClick={() => void run("issue")}
            disabled={!keyStatus?.canIssue || busy !== null}
            data-testid="get-my-token"
          >
            {busy === "issue" ? <Loader2 className="animate-spin" /> : <KeyRound />}
            Get my token
          </Button>
          <span className="text-[11px] text-text-muted">
            {keyStatus?.canIssue
              ? `Optio makes your own key in the gateway: ${keyTermsLine(keyStatus.defaults)}.` +
                (hasToken && pasting ? " It replaces the token you pasted." : "")
              : "An admin hasn't finished setting up the gateway's keys yet."}
          </span>
        </div>
      )}
      {lastTest && (
        <p className="text-[11px] text-text-muted" role="status">
          {lastTest}
        </p>
      )}

      {pasting ? (
        <>
          {issuing && (
            <p className="text-[11px] text-text-muted pt-1">
              {issued
                ? "Or paste a key you got from the gateway yourself; it replaces the one Optio made."
                : "Or paste a key you got from the gateway yourself."}
            </p>
          )}
          <GatewayTokenField
            testId="my-token"
            placeholder={hasToken ? "Paste a new token to replace it" : "Paste your token"}
            onSave={async (token) => (await api.setMyGatewayToken(token)).test}
            onSaved={onChanged}
          />
        </>
      ) : (
        !issued &&
        !issuing && (
          <p className="text-[11px] text-text-muted">An admin chooses how people get tokens.</p>
        )
      )}
    </div>
  );
}
