import { describe, expect, it } from "vitest";
import { preflightMessage } from "./gateway-preflight.js";
import { keyInfoOutcome } from "./outcome.js";

const NOW = new Date("2026-10-24T12:00:00Z");

/** The message a run fails with for the gateway's answer, or null when it goes on. */
function message(status: number, body: unknown): string | null {
  const outcome = keyInfoOutcome({ status, body }, NOW);
  if (!outcome || (!outcome.invalid && !outcome.overBudget)) return null;
  return preflightMessage(outcome, "Your", "Settings → My tokens");
}

describe("the gateway pre-flight's verdict", () => {
  it("lets a healthy, nearly spent, unknown or unreachable-looking token go on", () => {
    expect(message(200, { info: { spend: 1, max_budget: 5 } })).toBeNull();
    expect(message(200, { info: { spend: 4.5, max_budget: 5 } })).toBeNull();
    expect(message(404, null)).toBeNull();
    expect(message(502, "Bad gateway")).toBeNull();
  });

  it("says over budget until when, with the spend and where to fix it", () => {
    expect(
      message(200, {
        info: { spend: 5.1, max_budget: 5, budget_reset_at: "2026-11-01T00:00:00Z" },
      }),
    ).toBe(
      "Your gateway token is over budget until 2026-11-01 00:00 UTC (5.10 of 5.00 USD spent): Settings → My tokens",
    );
  });

  it("says blocked, expired, or refused", () => {
    expect(message(200, { info: { spend: 0, blocked: true } })).toMatch(
      /^Your gateway token is blocked on the gateway/,
    );
    expect(message(200, { info: { spend: 0, expires: "2026-10-20T08:30:00Z" } })).toBe(
      "Your gateway token expired on 2026-10-20 08:30 UTC and is rejected by the gateway: put in a new one under Settings → My tokens",
    );
    expect(
      message(401, { error: { message: "Authentication Error", type: "auth_error" } }),
    ).toMatch(/^Your gateway token was rejected by the gateway \(401/);
  });

  it("lets a run go on when the gateway only guards its management routes", () => {
    expect(message(403, { detail: "Forbidden" })).toBeNull();
    expect(message(403, null)).toBeNull();
    expect(message(401, { error: "Unauthorized" })).toBeNull();
    expect(
      message(403, { error: { message: "Route not allowed for virtual keys", type: "forbidden" } }),
    ).toBeNull();
  });

  it("names no amounts for a shared token and sends people to an admin", () => {
    const shared = (status: number, body: unknown) =>
      preflightMessage(
        keyInfoOutcome({ status, body }, NOW)!,
        "The organization's",
        "Settings → My tokens",
        true,
      );
    const over = shared(200, {
      info: { spend: 5.1, max_budget: 5, budget_reset_at: "2026-11-01T00:00:00Z" },
    });
    expect(over).toBe(
      "The organization's gateway token is over budget until 2026-11-01 00:00 UTC: ask an Optio admin to fix it (Settings → My tokens)",
    );
    expect(over).not.toMatch(/USD|5\.10|5\.00/);
    expect(
      shared(400, {
        error: { message: "Budget has been exceeded! Current cost: 5.1, Max budget: 5.0" },
      }),
    ).toBe(
      "The organization's gateway token is over budget: ask an Optio admin to fix it (Settings → My tokens)",
    );
    expect(shared(200, { info: { spend: 0, blocked: true } })).toMatch(
      /blocked.*ask an Optio admin/,
    );
  });
});
