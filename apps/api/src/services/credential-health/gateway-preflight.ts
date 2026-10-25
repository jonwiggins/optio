/**
 * The gateway pre-flight (docs/credential-health.md): before a run's pod is
 * provisioned, ask the gateway about the token the run will carry (LiteLLM
 * `GET /key/info`, OpenRouter `GET /api/v1/key`) and fail now when the
 * gateway already turns it away — over its budget, expired, blocked or
 * refused — with a message that says whose token it is, until when, and
 * where to fix it:
 *
 *   Your gateway token is over budget until 2026-11-01 00:00 UTC (5.10 of
 *   5.00 USD spent) — Settings → My tokens
 *   The Platform team's gateway token was rejected by the gateway (401) —
 *   put in a new one under Teams → Platform → Tokens
 *
 * The Claude OAuth token is checked before a run (task-worker.ts), and
 * that check is off under the gateway; this is the gateway's. It runs
 * inside `resolveGatewayRun` (gateway-run-service.ts), so Tasks, Jobs, PR
 * reviews and agent turns all get it. A gateway that can't be reached, or
 * whose type doesn't report a token's budget, lets the run go on: the
 * pre-flight only stops what it knows will fail.
 * `OPTIO_GATEWAY_PREFLIGHT=false` (chart `credentialHealth.gatewayPreflight`)
 * turns it off.
 *
 * A refusal also updates the token's row on Settings → System health.
 */
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { teams } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { gatewayKeyInfoRaw } from "../model-gateway-service.js";
import { ModelProviderError, type ModelProviderRow } from "../model-provider-service.js";
import { gatewayKey, gatewayLabel, gatewayScope, type GatewayHolder } from "./keys.js";
import { type CheckOutcome, formatUtc, keyInfoOutcome, spentOf } from "./outcome.js";
import { recordGatewayError } from "../../telemetry/site-metrics.js";

/** The gateway already refuses this run's token; the message says whose and where to fix it. */
export class GatewayPreflightError extends ModelProviderError {
  constructor(message: string) {
    super(message, 400);
    this.name = "GatewayPreflightError";
  }
}

export function gatewayPreflightEnabled(): boolean {
  return (process.env.OPTIO_GATEWAY_PREFLIGHT ?? "").trim().toLowerCase() !== "false";
}

export interface PreflightUse {
  row: ModelProviderRow;
  token: string;
  workspaceId: string | null | undefined;
  ownerUserId: string | null | undefined;
  ownerTeamId?: string | null;
  /** The model the run asked for (the metrics' `model` label). */
  model?: string | null;
}

interface Whose {
  holder: GatewayHolder;
  /** "Your", "The Platform team's", "The organization's", "The gateway's shared". */
  subject: string;
  fixAt: string;
}

async function whoseToken(use: PreflightUse): Promise<Whose> {
  if (use.row.tokenSource === "stored") {
    return {
      holder: { kind: "stored", userId: use.row.ownerUserId },
      subject: "The gateway's shared",
      fixAt: "Settings → Model gateway",
    };
  }
  if (use.ownerTeamId) {
    const [team] = await db
      .select({ name: teams.name })
      .from(teams)
      .where(eq(teams.id, use.ownerTeamId));
    const name = team?.name ?? "the team";
    return {
      holder: { kind: "team", teamId: use.ownerTeamId },
      subject: `The ${name} team's`,
      fixAt: `Teams → ${name} → Tokens`,
    };
  }
  if (use.ownerUserId) {
    return {
      holder: { kind: "user", userId: use.ownerUserId },
      subject: "Your",
      fixAt: "Settings → My tokens",
    };
  }
  return {
    holder: { kind: "org" },
    subject: "The organization's",
    fixAt: "Settings → Model gateway",
  };
}

/** The message a refused run fails with. */
export function preflightMessage(outcome: CheckOutcome, subject: string, fixAt: string): string {
  const token = `${subject} gateway token`;
  if (outcome.overBudget) {
    const o = outcome.overBudget;
    const spent = spentOf(o);
    if (o.resetAt)
      return `${token} is over budget until ${formatUtc(o.resetAt)} (${spent}) — ${fixAt}`;
    return o.resetUnknown
      ? `${token} is over budget (${spent}); the gateway refuses it until its budget resets or is raised — ${fixAt}`
      : `${token} is over budget (${spent}) and doesn't reset by itself — ask the gateway's admin to raise it, or put in another token under ${fixAt}`;
  }
  if (/^Blocked/.test(outcome.reason ?? "")) {
    return `${token} is blocked on the gateway — ask its admin, or put in a new one under ${fixAt}`;
  }
  if (/^Expired/.test(outcome.reason ?? "")) {
    const on = outcome.expiresAt ? ` on ${formatUtc(outcome.expiresAt)}` : "";
    return `${token} expired${on} and is rejected by the gateway — put in a new one under ${fixAt}`;
  }
  const why = outcome.reason?.replace(/^Rejected by the gateway\s*/, "").trim();
  return `${token} was rejected by the gateway${why ? ` ${why}` : ""} — put in a new one under ${fixAt}`;
}

/**
 * The status a pre-flight refusal is counted under
 * (`optio_gateway_errors_total`): 429 for a spent budget, the gateway's own
 * 401 / 403 for a token it refuses, else 401 (a 2xx that says blocked or
 * expired, a 400 `expired_key`). The alert reads 401 / 403 as a dead token
 * and 429 as a rate limit or a budget.
 */
export function preflightStatus(
  status: number,
  outcome: Pick<CheckOutcome, "overBudget" | "invalid">,
): number {
  if (outcome.overBudget) return 429;
  return status === 401 || status === 403 ? status : 401;
}

/**
 * Throws a `GatewayPreflightError` when the gateway already refuses the
 * token (budget spent, expired, blocked, wrong); returns otherwise,
 * including when it can't tell.
 */
export async function gatewayPreflight(use: PreflightUse, now: Date = new Date()): Promise<void> {
  if (!gatewayPreflightEnabled()) return;
  let res: { status: number; body: unknown };
  try {
    res = await gatewayKeyInfoRaw(use.row, use.token);
  } catch {
    return; // Unreachable: the run finds out itself.
  }
  // Its info; or LiteLLM's refusal of the key itself: over budget (a LiteLLM
  // that checks budgets on /key/info too), expired (a 400 `expired_key`),
  // wrong, deleted or blocked (a 401).
  const outcome = keyInfoOutcome(res, now);
  if (!outcome || (!outcome.invalid && !outcome.overBudget)) return;
  // The deployment's monitoring (docs/observability.md): a refusal by what it
  // means, as the alert reads the status: a spent budget as 429, a token
  // the gateway refuses (wrong, blocked, expired) as its 401 / 403, or 401
  // when /key/info said so with a 2xx or LiteLLM's 400 `expired_key`.
  recordGatewayError({
    status: preflightStatus(res.status, outcome),
    model: use.model,
    ownerTeamId: use.row.tokenSource === "stored" ? null : use.ownerTeamId,
    ownerUserId: use.row.tokenSource === "stored" ? null : use.ownerUserId,
    source: "preflight",
  });

  const whose = await whoseToken(use);
  const message = preflightMessage(outcome, whose.subject, whose.fixAt);
  try {
    // Loaded here: the run path never needs the table unless a token is refused.
    const { saveCheck } = await import("./store.js");
    const workspaceId =
      whose.holder.kind === "team" ? (use.workspaceId ?? null) : (use.row.workspaceId ?? null);
    await saveCheck(
      {
        key: gatewayKey(use.row.id, whose.holder),
        kind: "gateway",
        label: gatewayLabel(use.row),
        ...gatewayScope(whose.holder),
        workspaceId,
      },
      { ...outcome, details: { gateway: use.row.name, ...outcome.details } },
      now,
    );
  } catch (err) {
    logger.warn({ err }, "gateway pre-flight: couldn't record the token's health");
  }
  throw new GatewayPreflightError(message);
}
