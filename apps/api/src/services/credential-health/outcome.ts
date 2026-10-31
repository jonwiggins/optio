/**
 * Credential health (docs/credential-health.md): what one check found, and
 * the pure rules that turn a service's answer into a status and a reason a
 * person can act on. No I/O here; `checks.ts` asks the services.
 *
 *   ok       the service accepts the token and nothing is near its end
 *   warning  it works, but expires within 30 days, lacks a scope, or has
 *            used most of its budget
 *   error    the service refuses it (expired, revoked, wrong, blocked) or
 *            its budget is spent: work that uses it fails
 *   unknown  the service couldn't be reached or doesn't say
 */

export type CredentialStatus = "ok" | "warning" | "error" | "unknown";

export interface OverBudget {
  /** USD spent and the budget; null when the gateway said only "exceeded". */
  spend: number | null;
  maxBudget: number | null;
  /** ISO time the gateway resets the spend; null = it doesn't by itself (or, with `resetUnknown`, didn't say). */
  resetAt: string | null;
  /**
   * The gateway refused the key outright (LiteLLM's `budget_exceeded`) rather
   * than describing it, so whether and when it resets is unknown.
   */
  resetUnknown?: boolean;
}

export interface CheckOutcome {
  status: CredentialStatus;
  /** One sentence, or null when there is nothing to say. */
  reason: string | null;
  expiresAt: Date | null;
  /** What the check read (never the token): host, scopes, budget, account. */
  details: Record<string, unknown>;
  /** The service refused the token (401 / 403, revoked, expired): `token.invalid`. */
  invalid?: boolean;
  /**
   * The gateway turned the check away without saying the token is bad (a
   * bare 403, a 401 in no shape it is known to answer a bad key with): a
   * proxy that guards its management routes does this to keys that work for
   * models. Shown as an error, but no run is failed and no notice goes out.
   */
  unconfirmed?: boolean;
  /** Spend at or over the budget: `budget.exceeded`. */
  overBudget?: OverBudget | null;
}

export const DAY_MS = 86_400_000;

/** Within this many days of its end a token is a warning, and the first notice goes out. */
export const EXPIRY_WARNING_DAYS = 30;

/** The thresholds a `token.expiring` notice goes out at, most distant first. */
export const EXPIRY_THRESHOLDS = [30, 7, 1] as const;

/** The share of a budget past which the page warns (no notice: that is `budget.exceeded`). */
export const BUDGET_WARNING_SHARE = 0.8;

const RANK: Record<CredentialStatus, number> = { ok: 0, unknown: 1, warning: 2, error: 3 };

/** The worse of two statuses. */
export function worse(a: CredentialStatus, b: CredentialStatus): CredentialStatus {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Whole days left until `expiresAt`, rounded up (0 or less: it has passed). */
export function daysLeft(expiresAt: Date, now: Date): number {
  return Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS);
}

/** `2026-11-01 00:00 UTC`: the same text everywhere (pages, emails, error messages). */
export function formatUtc(value: Date | string): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/** "in 1 day", "in 12 days", "today". */
export function inDays(days: number): string {
  if (days <= 0) return "today";
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

/** The status and sentence for a token that ends at `expiresAt` (null when it doesn't end). */
export function expiryVerdict(
  expiresAt: Date | null,
  now: Date,
): { status: CredentialStatus; reason: string | null; expired: boolean } {
  if (!expiresAt) return { status: "ok", reason: null, expired: false };
  const days = daysLeft(expiresAt, now);
  if (expiresAt.getTime() <= now.getTime()) {
    return { status: "error", reason: `Expired on ${formatUtc(expiresAt)}`, expired: true };
  }
  if (days <= EXPIRY_WARNING_DAYS) {
    return {
      status: "warning",
      reason: `Expires ${inDays(days)} (${formatUtc(expiresAt)})`,
      expired: false,
    };
  }
  return { status: "ok", reason: null, expired: false };
}

/** Joins the sentences that apply, in order. */
export function reasons(...parts: Array<string | null | undefined | false>): string | null {
  const kept = parts.filter((p): p is string => !!p && p.trim() !== "");
  return kept.length ? kept.join(". ") : null;
}

// ── GitLab: GET /personal_access_tokens/self ────────────────────────────────

/** The scope Optio needs: the API (merge requests, webhooks, merges) and git over HTTPS. */
export const GITLAB_REQUIRED_SCOPE = "api";

export interface GitLabTokenSelf {
  name?: string;
  scopes?: string[];
  revoked?: boolean;
  active?: boolean;
  /** `YYYY-MM-DD`; the token stops working at 00:00 UTC that day. */
  expires_at?: string | null;
  user_id?: number;
}

/** GitLab's `expires_at` date → the moment it stops working (00:00 UTC that day). */
export function gitlabExpiry(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The outcome of a 200 from `/personal_access_tokens/self`. */
export function gitlabSelfOutcome(body: GitLabTokenSelf, now: Date, host: string): CheckOutcome {
  const expiresAt = gitlabExpiry(body.expires_at);
  const scopes = Array.isArray(body.scopes) ? body.scopes.map(String) : [];
  const details = { host, scopes, tokenName: body.name ?? null };
  if (body.revoked) {
    return { status: "error", reason: `Revoked on ${host}`, expiresAt, details, invalid: true };
  }
  const expiry = expiryVerdict(expiresAt, now);
  if (body.active === false || expiry.expired) {
    return {
      status: "error",
      reason: expiry.reason ?? `No longer active on ${host}`,
      expiresAt,
      details,
      invalid: true,
    };
  }
  const missingScope =
    scopes.length > 0 && !scopes.includes(GITLAB_REQUIRED_SCOPE)
      ? `Lacks the api scope (has ${scopes.join(", ")}): Optio can't open merge requests or keep webhooks with it`
      : null;
  return {
    status: worse(expiry.status, missingScope ? "warning" : "ok"),
    reason: reasons(expiry.reason, missingScope),
    expiresAt,
    details,
  };
}

// ── The gateway: LiteLLM GET /key/info (OpenRouter's /api/v1/key in its shape) ─

export interface GatewayKeyHealth {
  spend: number;
  maxBudget: number | null;
  budgetResetAt: string | null;
  budgetDuration: string | null;
  expires: string | null;
  blocked: boolean;
  keyAlias: string | null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** LiteLLM `/key/info` → `{ info: { spend, max_budget, budget_reset_at, expires, blocked, … } }`. */
export function parseKeyHealth(body: unknown): GatewayKeyHealth | null {
  const info = (body as { info?: Record<string, unknown> | null })?.info;
  if (!info || typeof info !== "object") return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    spend: num(info.spend) ?? 0,
    maxBudget: num(info.max_budget),
    budgetResetAt: str(info.budget_reset_at),
    budgetDuration: str(info.budget_duration),
    expires: str(info.expires),
    blocked: info.blocked === true,
    keyAlias: str(info.key_alias),
  };
}

/** Whether the key's spend has reached its budget, and until when. */
export function overBudget(info: GatewayKeyHealth): OverBudget | null {
  if (info.maxBudget === null || info.spend < info.maxBudget) return null;
  return { spend: info.spend, maxBudget: info.maxBudget, resetAt: info.budgetResetAt };
}

const usd = (n: number) => (n >= 1 || n === 0 ? n.toFixed(2) : n.toPrecision(2));

/** "5.10 of 5.00 USD spent". */
export function spentText(spend: number, maxBudget: number): string {
  return `${usd(spend)} of ${usd(maxBudget)} USD spent`;
}

/** What an over-budget key spent, as far as the gateway said. */
export function spentOf(over: OverBudget): string {
  return over.spend !== null && over.maxBudget !== null
    ? spentText(over.spend, over.maxBudget)
    : "its budget is spent";
}

/**
 * LiteLLM's refusal of a key over its budget: `{ error: { type:
 * "budget_exceeded", message: "Budget has been exceeded! Current cost: 5.1,
 * Max budget: 5.0" } }`. Versions that check the budget on every route
 * answer `/key/info` with it too, so the key's own info (and its reset)
 * can't be read; null for any other answer.
 */
export function gatewayBudgetError(body: unknown): OverBudget | null {
  const e = (body as { error?: { message?: unknown; type?: unknown } | string } | null)?.error;
  const message =
    typeof e === "string" ? e : typeof e?.message === "string" ? (e.message as string) : "";
  const type = e && typeof e === "object" ? e.type : undefined;
  if (
    type !== "budget_exceeded" &&
    !/Budget has been exceeded|Exceeded(?:Token)?Budget|budget_exceeded/i.test(message)
  ) {
    return null;
  }
  const m = message.match(/Current cost:\s*([\d.eE+-]+),?\s*Max budget:\s*([\d.eE+-]+)/i);
  const spend = m ? Number(m[1]) : NaN;
  const maxBudget = m ? Number(m[2]) : NaN;
  const known = Number.isFinite(spend) && Number.isFinite(maxBudget);
  return {
    spend: known ? spend : null,
    maxBudget: known ? maxBudget : null,
    resetAt: null,
    resetUnknown: true,
  };
}

/**
 * LiteLLM's `{ error: { type, message } }` (or `{ error: "…" }`, `{ detail:
 * "…" }`); OpenRouter's `{ error: { code, message } }`.
 */
function gatewayError(body: unknown): {
  type: string | null;
  code: string | null;
  message: string;
} {
  const b = (body ?? {}) as {
    error?: { message?: unknown; type?: unknown; code?: unknown } | string;
    detail?: unknown;
  };
  if (typeof b.error === "string") return { type: null, code: null, message: b.error };
  if (b.error && typeof b.error === "object") {
    const code = b.error.code;
    return {
      type: typeof b.error.type === "string" ? b.error.type : null,
      code: typeof code === "string" || typeof code === "number" ? String(code) : null,
      message: typeof b.error.message === "string" ? b.error.message : "",
    };
  }
  return { type: null, code: null, message: typeof b.detail === "string" ? b.detail : "" };
}

/** LiteLLM's Python time ("2026-10-20 12:00:00.123456+00:00"); no zone is UTC, as LiteLLM reads it. */
function pythonTime(value: string | undefined): Date | null {
  if (!value) return null;
  let v = value.trim().replace(" ", "T");
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(v)) v += "Z";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The gateway turned the key away on its own: LiteLLM authenticates every
 * route, `/key/info` included, before it answers. An expired key gets a 400
 * `{ error: { type: "expired_key", message: "Authentication Error - Expired
 * Key. Key Expiry time <t> and current time <t>" } }`; a wrong, deleted or
 * blocked one a 401 (`auth_error`); OpenRouter answers a key it doesn't
 * know with a 401 `{ error: { code: 401 } }`. Those are the token's fault.
 * Any other 401 or 403 is `unconfirmed`: a LiteLLM with `allowed_routes` or
 * `disable_admin_endpoints`, or a proxy in front that guards management
 * routes, turns `/key/info` away for keys that work for models. Null for
 * any other answer (a budget refusal is `gatewayBudgetError`'s).
 */
export function gatewayRefusal(status: number, body: unknown): CheckOutcome | null {
  const e = gatewayError(body);
  if (e.type === "expired_key" || /Expired Key/i.test(e.message)) {
    const at = pythonTime(e.message.match(/Key Expiry time\s+(.+?)\s+and current time/i)?.[1]);
    return {
      status: "error",
      reason: at ? `Expired on ${formatUtc(at)}` : "Expired: the gateway refuses it",
      expiresAt: at,
      details: {},
      invalid: true,
    };
  }
  const why = gatewayErrorText(body);
  if (e.type === "auth_error" || (status === 401 && e.code === "401")) {
    return {
      status: "error",
      reason: `Rejected by the gateway (${status}${why ? `: ${why}` : ""})`,
      expiresAt: null,
      details: {},
      invalid: true,
    };
  }
  if (status === 401 || status === 403) {
    return {
      status: "error",
      reason: `The gateway wouldn't describe it (${status}${why ? `: ${why}` : ""}); runs may still work`,
      expiresAt: null,
      details: {},
      unconfirmed: true,
    };
  }
  return null;
}

/** The outcome of a key the gateway refused as over budget (`gatewayBudgetError`). */
export function budgetErrorOutcome(
  over: OverBudget,
  details: Record<string, unknown> = {},
): CheckOutcome {
  return {
    status: "error",
    reason: `Over budget: ${spentOf(over)}; the gateway refuses it and doesn't say when it resets`,
    expiresAt: null,
    details: { ...details, spend: over.spend, maxBudget: over.maxBudget },
    overBudget: over,
  };
}

/** The outcome of a 200 from `/key/info`. */
export function gatewayKeyOutcome(info: GatewayKeyHealth, now: Date): CheckOutcome {
  const expiresAt = info.expires ? new Date(info.expires) : null;
  const validExpiry = expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null;
  const details = {
    spend: info.spend,
    maxBudget: info.maxBudget,
    budgetResetAt: info.budgetResetAt,
    budgetDuration: info.budgetDuration,
    keyAlias: info.keyAlias,
  };
  if (info.blocked) {
    return {
      status: "error",
      reason: "Blocked on the gateway",
      expiresAt: validExpiry,
      details,
      invalid: true,
    };
  }
  const expiry = expiryVerdict(validExpiry, now);
  if (expiry.expired) {
    return {
      status: "error",
      reason: expiry.reason,
      expiresAt: validExpiry,
      details,
      invalid: true,
    };
  }
  const over = overBudget(info);
  if (over) {
    const until = over.resetAt
      ? `until ${formatUtc(over.resetAt)}`
      : "with no reset (the gateway's admin raises it)";
    return {
      status: "error",
      reason: reasons(`Over budget ${until}: ${spentOf(over)}`, expiry.reason),
      expiresAt: validExpiry,
      details,
      overBudget: over,
    };
  }
  const nearBudget =
    info.maxBudget !== null &&
    info.maxBudget > 0 &&
    info.spend >= BUDGET_WARNING_SHARE * info.maxBudget
      ? `Used ${Math.floor((info.spend / info.maxBudget) * 100)}% of its budget (${spentText(info.spend, info.maxBudget)}${info.budgetResetAt ? `, resets ${formatUtc(info.budgetResetAt)}` : ""})`
      : null;
  return {
    status: worse(expiry.status, nearBudget ? "warning" : "ok"),
    reason: reasons(expiry.reason, nearBudget),
    expiresAt: validExpiry,
    details,
  };
}

/**
 * What LiteLLM's answer to `GET /key/info` (asked with the key itself) says
 * about the key: its info on a 200; else a budget refusal (checked first:
 * older LiteLLMs send "ExceededTokenBudget" as a 401); else an expired or
 * refused key. Null when the answer says nothing about it (a gateway that
 * isn't LiteLLM, a 5xx).
 */
export function keyInfoOutcome(
  res: { status: number; body: unknown },
  now: Date,
): CheckOutcome | null {
  if (res.status === 200) {
    const info = parseKeyHealth(res.body);
    if (info) return gatewayKeyOutcome(info, now);
  }
  const budget = gatewayBudgetError(res.body);
  if (budget) return budgetErrorOutcome(budget);
  return gatewayRefusal(res.status, res.body);
}

/** LiteLLM's error message without the parts that quote the key. */
export function gatewayErrorText(body: unknown): string {
  const e = (body as { error?: { message?: unknown } | string; detail?: unknown }) ?? {};
  const raw =
    typeof e.error === "string"
      ? e.error
      : typeof e.error?.message === "string"
        ? e.error.message
        : typeof e.detail === "string"
          ? e.detail
          : "";
  return raw
    .split(/Received API Key|Key Hash|API Key =|sk-/i)[0]
    .replace(/[\s.,:;-]+$/, "")
    .slice(0, 160);
}
