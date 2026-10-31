import { describe, expect, it } from "vitest";
import {
  budgetErrorOutcome,
  daysLeft,
  expiryVerdict,
  formatUtc,
  gatewayBudgetError,
  gatewayErrorText,
  gatewayKeyOutcome,
  gatewayRefusal,
  gitlabExpiry,
  gitlabSelfOutcome,
  keyInfoOutcome,
  parseKeyHealth,
  worse,
} from "./outcome.js";

const NOW = new Date("2026-10-24T12:00:00Z");
const inDaysFromNow = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

describe("expiry", () => {
  it("counts whole days up, and calls the last 30 a warning, the past an error", () => {
    expect(daysLeft(inDaysFromNow(6.5), NOW)).toBe(7);
    expect(expiryVerdict(null, NOW).status).toBe("ok");
    expect(expiryVerdict(inDaysFromNow(31), NOW).status).toBe("ok");
    const soon = expiryVerdict(inDaysFromNow(1), NOW);
    expect(soon.status).toBe("warning");
    expect(soon.reason).toBe("Expires in 1 day (2026-10-25 12:00 UTC)");
    const gone = expiryVerdict(inDaysFromNow(-1), NOW);
    expect(gone).toMatchObject({ status: "error", expired: true });
    expect(gone.reason).toBe("Expired on 2026-10-23 12:00 UTC");
  });

  it("reads GitLab's date as 00:00 UTC that day", () => {
    expect(gitlabExpiry("2026-11-01")?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(gitlabExpiry(null)).toBeNull();
    expect(formatUtc("2026-11-01T00:00:00Z")).toBe("2026-11-01 00:00 UTC");
  });

  it("orders statuses: error over warning over unknown over ok", () => {
    expect(worse("ok", "warning")).toBe("warning");
    expect(worse("error", "warning")).toBe("error");
    expect(worse("unknown", "ok")).toBe("unknown");
  });
});

describe("GitLab /personal_access_tokens/self", () => {
  it("is fine with the api scope and a far expiry", () => {
    const o = gitlabSelfOutcome(
      { name: "optio", scopes: ["api"], active: true, revoked: false, expires_at: "2027-06-01" },
      NOW,
      "gitlab.example.test",
    );
    expect(o).toMatchObject({ status: "ok", reason: null });
    expect(o.details).toMatchObject({ host: "gitlab.example.test", scopes: ["api"] });
  });

  it("warns 7 days out and about a missing api scope, in one reason", () => {
    const o = gitlabSelfOutcome(
      { scopes: ["read_api", "write_repository"], active: true, expires_at: "2026-10-31" },
      NOW,
      "gitlab.example.test",
    );
    expect(o.status).toBe("warning");
    expect(o.reason).toContain("Expires in 7 days (2026-10-31 00:00 UTC)");
    expect(o.reason).toContain("Lacks the api scope (has read_api, write_repository)");
    expect(o.invalid).toBeUndefined();
  });

  it("is an error, and invalid, when revoked or past its date", () => {
    expect(
      gitlabSelfOutcome({ scopes: ["api"], revoked: true }, NOW, "gitlab.example.test"),
    ).toMatchObject({ status: "error", invalid: true, reason: "Revoked on gitlab.example.test" });
    expect(
      gitlabSelfOutcome(
        { scopes: ["api"], active: false, expires_at: "2026-10-01" },
        NOW,
        "gitlab.example.test",
      ),
    ).toMatchObject({ status: "error", invalid: true, reason: "Expired on 2026-10-01 00:00 UTC" });
  });
});

describe("LiteLLM /key/info", () => {
  const info = (over: Record<string, unknown>) =>
    parseKeyHealth({ key: "hash", info: { spend: 0, max_budget: null, ...over } })!;

  it("parses what the page needs and ignores what isn't LiteLLM", () => {
    expect(parseKeyHealth({ data: [] })).toBeNull();
    expect(
      info({ spend: "1.5", max_budget: 5, budget_reset_at: "2026-11-01T00:00:00Z", blocked: true }),
    ).toMatchObject({
      spend: 1.5,
      maxBudget: 5,
      budgetResetAt: "2026-11-01T00:00:00Z",
      blocked: true,
    });
  });

  it("over budget is an error until the reset, with the spend", () => {
    const o = gatewayKeyOutcome(
      info({ spend: 5.1, max_budget: 5, budget_reset_at: "2026-11-01T00:00:00Z" }),
      NOW,
    );
    expect(o.status).toBe("error");
    expect(o.overBudget).toEqual({ spend: 5.1, maxBudget: 5, resetAt: "2026-11-01T00:00:00Z" });
    expect(o.reason).toBe("Over budget until 2026-11-01 00:00 UTC: 5.10 of 5.00 USD spent");
    expect(o.invalid).toBeUndefined();
  });

  it("a budget of almost nothing, spent, is over budget too", () => {
    const o = gatewayKeyOutcome(info({ spend: 0.00002, max_budget: 0.000001 }), NOW);
    expect(o.overBudget).not.toBeNull();
    expect(o.reason).toContain("with no reset");
  });

  it("warns past 80% of the budget, and a day before the key expires", () => {
    const near = gatewayKeyOutcome(info({ spend: 4.2, max_budget: 5 }), NOW);
    expect(near.status).toBe("warning");
    expect(near.reason).toContain("Used 84% of its budget");
    const expiring = gatewayKeyOutcome(info({ expires: inDaysFromNow(0.9).toISOString() }), NOW);
    expect(expiring.status).toBe("warning");
    expect(expiring.reason).toMatch(/^Expires in 1 day/);
    expect(expiring.expiresAt?.toISOString()).toBe(inDaysFromNow(0.9).toISOString());
  });

  it("an expired key: LiteLLM's 400 expired_key on /key/info, with when it expired", () => {
    // What LiteLLM answers (proxy/auth/user_api_key_auth.py): it authenticates
    // /key/info too, so an expired key never gets its info back. `param` is the key.
    const body = {
      error: {
        message:
          "Authentication Error - Expired Key. Key Expiry time 2026-10-20 08:30:00.123456+00:00 and current time 2026-10-24 12:00:00.000001+00:00",
        type: "expired_key",
        param: "sk-e2e-expired",
        code: "400",
      },
    };
    const o = keyInfoOutcome({ status: 400, body }, NOW)!;
    expect(o).toMatchObject({
      status: "error",
      invalid: true,
      reason: "Expired on 2026-10-20 08:30 UTC",
    });
    expect(o.expiresAt?.toISOString()).toBe("2026-10-20T08:30:00.123Z");
    expect(JSON.stringify(o)).not.toContain("sk-e2e-expired");
    // Without a time it can read, still expired and refused.
    expect(
      gatewayRefusal(400, { error: { type: "expired_key", message: "Expired Key" } }),
    ).toMatchObject({ status: "error", invalid: true, reason: "Expired: the gateway refuses it" });
    expect(
      gatewayRefusal(400, {
        error:
          "Authentication Error - Expired Key. Key Expiry time 2026-10-20 08:30:00 and current time x",
      })?.expiresAt?.toISOString(),
    ).toBe("2026-10-20T08:30:00.000Z");
  });

  it("a wrong, deleted or blocked key: LiteLLM's 401 auth_error", () => {
    const blocked = keyInfoOutcome(
      {
        status: 401,
        body: {
          error: {
            message:
              "Authentication Error, Key is blocked. Update via `/key/unblock` if you're admin.",
            type: "auth_error",
            param: "None",
            code: "401",
          },
        },
      },
      NOW,
    );
    expect(blocked).toMatchObject({ status: "error", invalid: true });
    expect(blocked!.reason).toBe(
      "Rejected by the gateway (401: Authentication Error, Key is blocked. Update via `/key/unblock` if you're admin)",
    );
    expect(
      gatewayRefusal(400, { error: { type: "auth_error", message: "Bad key" } }),
    ).toMatchObject({ reason: "Rejected by the gateway (400: Bad key)", invalid: true });
    // Not a refusal of the key: a 5xx, a budget refusal, a gateway that isn't LiteLLM.
    expect(gatewayRefusal(500, { error: { message: "boom" } })).toBeNull();
    expect(keyInfoOutcome({ status: 404, body: { detail: "Not Found" } }, NOW)).toBeNull();
  });

  it("a blocked key LiteLLM still describes is refused", () => {
    expect(gatewayKeyOutcome(info({ blocked: true }), NOW)).toMatchObject({
      status: "error",
      invalid: true,
      reason: "Blocked on the gateway",
    });
  });

  it("an older LiteLLM's 401 'ExceededTokenBudget' is over budget, not a wrong key", () => {
    const o = keyInfoOutcome(
      {
        status: 401,
        body: {
          error: {
            message:
              "Authentication Error, ExceededTokenBudget: Current spend for token: 5.2; Max Budget for Token: 5.0",
            type: "auth_error",
          },
        },
      },
      NOW,
    );
    expect(o).toMatchObject({ status: "error", overBudget: { resetUnknown: true } });
    expect(o!.invalid).toBeUndefined();
  });

  it("keeps LiteLLM's reason but never the part that quotes the key", () => {
    expect(
      gatewayErrorText({
        error: {
          message:
            "Authentication Error, Invalid proxy server token passed. Received API Key = sk-...abcd, Key Hash (Token) =9f3",
        },
      }),
    ).toBe("Authentication Error, Invalid proxy server token passed");
    expect(gatewayErrorText({ error: "Authentication Error - Expired Key" })).toBe(
      "Authentication Error - Expired Key",
    );
  });

  it("reads LiteLLM's outright budget refusal (versions that check it on /key/info too)", () => {
    const over = gatewayBudgetError({
      error: {
        message: "Budget has been exceeded! Current cost: 0.0, Max budget: 0.0",
        type: "budget_exceeded",
        param: null,
        code: "400",
      },
    });
    expect(over).toEqual({ spend: 0, maxBudget: 0, resetAt: null, resetUnknown: true });
    const outcome = budgetErrorOutcome(over!);
    expect(outcome).toMatchObject({ status: "error", overBudget: over });
    expect(outcome.reason).toBe(
      "Over budget: 0.00 of 0.00 USD spent; the gateway refuses it and doesn't say when it resets",
    );
    expect(gatewayBudgetError({ error: "ExceededTokenBudget: over" })).toMatchObject({
      spend: null,
      resetUnknown: true,
    });
    expect(gatewayBudgetError({ error: { message: "Invalid proxy server token" } })).toBeNull();
    expect(gatewayBudgetError(null)).toBeNull();
  });
});
