/**
 * The gateway pre-flight (docs/credential-health.md): before a run's pod is
 * provisioned, ask the gateway about the token the run will carry (LiteLLM
 * `GET /key/info`, OpenRouter `GET /api/v1/key`) and fail now when the
 * gateway already turns it away (over its budget, expired, blocked or
 * refused), with a message that says whose token it is, until when, and
 * where to fix it:
 *
 *   Your gateway token is over budget until 2026-11-01 00:00 UTC (5.10 of
 *   5.00 USD spent): Settings → My tokens
 *
 * It runs inside `resolveGatewayRun` (gateway-run-service.ts), so tasks,
 * Jobs, PR reviews and agent turns all get it, with the token the run was
 * resolved with (the consent already checked). A gateway that can't be
 * reached, or whose type doesn't report a token's budget, lets the run go
 * on: the pre-flight only stops what it knows will fail.
 * `OPTIO_GATEWAY_PREFLIGHT=false` turns it off.
 *
 * A refusal also updates the token's row in credential health.
 */
import { logger } from "../../logger.js";
import { gatewayKeyInfoRaw } from "../model-gateway-service.js";
import { ModelProviderError, type ModelProviderRow } from "../model-provider-service.js";
import { gatewayFixAt, gatewayKey, gatewayLabel, type GatewayHolder } from "./inventory.js";
import { type CheckOutcome, formatUtc, keyInfoOutcome, spentOf } from "./outcome.js";

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
  /** The work's owner (null = the organization's). */
  ownerUserId: string | null | undefined;
}

function holderOf(use: PreflightUse): { holder: GatewayHolder; subject: string } {
  if (use.row.tokenSource === "stored") {
    return { holder: { kind: "stored" }, subject: "The gateway's shared" };
  }
  if (use.ownerUserId)
    return { holder: { kind: "user", userId: use.ownerUserId }, subject: "Your" };
  return { holder: { kind: "org" }, subject: "The organization's" };
}

/** The message a refused run fails with. */
export function preflightMessage(outcome: CheckOutcome, subject: string, fixAt: string): string {
  const token = `${subject} gateway token`;
  if (outcome.overBudget) {
    const o = outcome.overBudget;
    const spent = spentOf(o);
    if (o.resetAt)
      return `${token} is over budget until ${formatUtc(o.resetAt)} (${spent}): ${fixAt}`;
    return o.resetUnknown
      ? `${token} is over budget (${spent}); the gateway refuses it until its budget resets or is raised: ${fixAt}`
      : `${token} is over budget (${spent}) and doesn't reset by itself: ask the gateway's admin to raise it, or put in another token under ${fixAt}`;
  }
  if (/^Blocked/.test(outcome.reason ?? "")) {
    return `${token} is blocked on the gateway: ask its admin, or put in a new one under ${fixAt}`;
  }
  if (/^Expired/.test(outcome.reason ?? "")) {
    const on = outcome.expiresAt ? ` on ${formatUtc(outcome.expiresAt)}` : "";
    return `${token} expired${on} and is rejected by the gateway: put in a new one under ${fixAt}`;
  }
  const why = outcome.reason?.replace(/^Rejected by the gateway\s*/, "").trim();
  return `${token} was rejected by the gateway${why ? ` ${why}` : ""}: put in a new one under ${fixAt}`;
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
  const outcome = keyInfoOutcome(res, now);
  if (!outcome || (!outcome.invalid && !outcome.overBudget)) return;
  const { holder, subject } = holderOf(use);
  const fixAt = gatewayFixAt(holder);
  try {
    // Loaded here: the run path never needs the table unless a token is refused.
    const { saveCheck } = await import("./store.js");
    await saveCheck(
      {
        key: gatewayKey(use.row.id, holder),
        kind: "gateway",
        label: gatewayLabel(use.row),
        scope: holder.kind === "user" ? "person" : "organization",
        workspaceId: use.row.workspaceId ?? null,
        userId: holder.kind === "user" ? holder.userId : null,
      },
      { ...outcome, details: { gateway: use.row.name, ...outcome.details } },
      now,
    );
  } catch (err) {
    logger.warn({ err }, "gateway pre-flight: couldn't record the token's health");
  }
  throw new GatewayPreflightError(preflightMessage(outcome, subject, fixAt));
}
