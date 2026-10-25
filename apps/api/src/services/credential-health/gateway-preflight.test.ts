import { describe, expect, it } from "vitest";
import { preflightStatus } from "./gateway-preflight.js";
import { keyInfoOutcome } from "./outcome.js";

const NOW = new Date("2026-10-24T12:00:00Z");

/** The status the deployment's monitoring counts LiteLLM's /key/info answer under. */
function counted(status: number, body: unknown): number | null {
  const outcome = keyInfoOutcome({ status, body }, NOW);
  if (!outcome || (!outcome.invalid && !outcome.overBudget)) return null;
  return preflightStatus(status, outcome);
}

// Optio_gateway_errors_total's `status` (docs/observability.md "Prometheus
// endpoint and dashboard"). OptioGatewayRefusing reads 401 / 403 as a token the gateway
// refuses and 429 as a rate limit or a spent budget.
describe("the status a pre-flight refusal is counted under", () => {
  it("a blocked or expired key that /key/info answers with a 2xx: 401, a dead token", () => {
    expect(counted(200, { info: { spend: 0, max_budget: 5, blocked: true } })).toBe(401);
    expect(counted(200, { info: { spend: 0, expires: "2026-10-20T08:30:00Z" } })).toBe(401);
  });

  it("a spent budget: 429, whether /key/info says so with a 200 or LiteLLM's 400", () => {
    expect(counted(200, { info: { spend: 1.5, max_budget: 1 } })).toBe(429);
    expect(
      counted(400, {
        error: {
          message: "Budget has been exceeded! Current cost: 2.5, Max budget: 2.0",
          type: "budget_exceeded",
        },
      }),
    ).toBe(429);
  });

  it("LiteLLM's 400 `expired_key`: 401; the gateway's own 401 / 403 kept", () => {
    expect(
      counted(400, {
        error: { message: "Authentication Error - Expired Key.", type: "expired_key" },
      }),
    ).toBe(401);
    expect(counted(401, { error: { message: "Authentication Error, Invalid proxy" } })).toBe(401);
    expect(counted(403, { error: { message: "Forbidden" } })).toBe(403);
  });

  it("a working key isn't counted", () => {
    expect(counted(200, { info: { spend: 0.1, max_budget: 5 } })).toBeNull();
  });
});
