import { describe, expect, it, vi } from "vitest";

vi.mock("../notify.js", async () => {
  // The skip reasons are the real ones (notify/fanout.ts): delivered() compares them.
  const { NO_ADDRESS, NO_RELAY } =
    await vi.importActual<typeof import("../notify/fanout.js")>("../notify/fanout.js");
  return { notify: vi.fn(), NO_ADDRESS, NO_RELAY };
});
vi.mock("../sign-in-config-service.js", () => ({ listDeploymentAdmins: vi.fn(async () => []) }));

import { NO_ADDRESS, NO_RELAY } from "../notify.js";
import { delivered, dueAlerts, mergeResults, noticeFor } from "./alerts.js";
import type { CredentialRef } from "./inventory.js";
import type { CheckOutcome } from "./outcome.js";

const NOW = new Date("2026-10-24T12:00:00Z");
const day = 86_400_000;
const expiring = (days: number): CheckOutcome => ({
  status: days <= 30 ? "warning" : "ok",
  reason: null,
  expiresAt: new Date(NOW.getTime() + days * day),
  details: {},
});
const markersOf = (r: ReturnType<typeof dueAlerts>) => r.alerts.flatMap((a) => a.markers);

describe("which warnings are due", () => {
  it("sends the 30-day warning once, then the 7-day and the 1-day ones", () => {
    const token = expiring(29); // one token, checked as the days go by
    const later = (days: number) => new Date(NOW.getTime() + days * day);
    const sent: Record<string, string> = {};
    const pass = (at: Date) => {
      const r = dueAlerts(sent, token, at);
      for (const k of Object.keys(sent)) if (!(k in r.keep)) delete sent[k];
      for (const m of markersOf(r)) sent[m] = at.toISOString();
      return r.alerts.map((a) => a.threshold);
    };
    expect(pass(NOW)).toEqual([30]);
    expect(pass(later(1))).toEqual([]); // the next passes: nothing new
    expect(pass(later(10))).toEqual([]);
    expect(pass(later(22))).toEqual([7]);
    expect(pass(later(23))).toEqual([]);
    expect(pass(later(28.5))).toEqual([1]);
    expect(pass(later(28.6))).toEqual([]);
  });

  it("first seen 5 days out: the 7-day warning only, never the 30-day one after", () => {
    const r = dueAlerts({}, expiring(5), NOW);
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0].threshold).toBe(7);
    const date = new Date(NOW.getTime() + 5 * day).toISOString().slice(0, 10);
    expect(r.alerts[0].markers.sort()).toEqual([`expiry:30:${date}`, `expiry:7:${date}`]);
  });

  it("a renewed token (another date) gets its own warnings, and drops the old markers", () => {
    const old = { "expiry:30:2026-11-01": NOW.toISOString(), "expiry:7:2026-11-01": "x" };
    const r = dueAlerts(old, expiring(20), NOW);
    expect(Object.keys(r.keep)).toEqual([]);
    expect(r.alerts).toEqual([expect.objectContaining({ threshold: 30 })]);
  });

  it("an invalid token is told once; working again clears it for next time", () => {
    const bad: CheckOutcome = {
      status: "error",
      reason: "refused",
      expiresAt: null,
      details: {},
      invalid: true,
    };
    const first = dueAlerts({}, bad, NOW);
    expect(first.alerts.map((a) => a.kind)).toEqual(["token.invalid"]);
    expect(dueAlerts({ invalid: "t" }, bad, NOW).alerts).toEqual([]);
    const fixed = dueAlerts({ invalid: "t" }, expiring(200), NOW);
    expect(fixed.keep.invalid).toBeUndefined();
  });

  it("over budget once per reset", () => {
    const over: CheckOutcome = {
      status: "error",
      reason: "over",
      expiresAt: null,
      details: {},
      overBudget: { spend: 5.1, maxBudget: 5, resetAt: "2026-11-01T00:00:00Z" },
    };
    const r = dueAlerts({}, over, NOW);
    expect(r.alerts).toEqual([
      { kind: "budget.exceeded", markers: ["budget:2026-11-01T00:00:00Z"] },
    ]);
    expect(dueAlerts({ "budget:2026-11-01T00:00:00Z": "t" }, over, NOW).alerts).toEqual([]);
    // The next month's overrun is news again.
    const next = { ...over, overBudget: { ...over.overBudget!, resetAt: "2026-12-01T00:00:00Z" } };
    expect(dueAlerts({ "budget:2026-11-01T00:00:00Z": "t" }, next, NOW).alerts).toHaveLength(1);
  });

  it("an unreachable service changes nothing", () => {
    const keep = { invalid: "t", "budget:none": "t" };
    const r = dueAlerts(
      keep,
      { status: "unknown", reason: "down", expiresAt: null, details: {} },
      NOW,
    );
    expect(r).toEqual({ alerts: [], keep });
  });
});

describe("the email", () => {
  const ref = (over: Partial<CredentialRef>): CredentialRef => ({
    key: "k",
    kind: "gitlab",
    label: "GitLab token",
    scope: "organization",
    workspaceId: null,
    userId: null,
    fixAt: "Settings → Secrets",
    check: async () => expiring(1),
    ...over,
  });

  it("says whose, when, what stops, and where to fix it", () => {
    const n = noticeFor(ref({}), expiring(1), { kind: "token.expiring", markers: [] }, NOW);
    expect(n.subject).toBe("The organization's GitLab token expires in 1 day");
    expect(n.body).toContain("webhooks, merge requests and merges");
    expect(n.body).toContain("Fix it under Settings → Secrets");
    const mine = noticeFor(
      ref({ scope: "person", userId: "u1", fixAt: "Settings → My tokens" }),
      expiring(7),
      { kind: "token.expiring", markers: [] },
      NOW,
    );
    expect(mine.subject).toBe("Your GitLab token expires in 7 days");
    expect(mine.body).toContain("Settings → My tokens");
  });

  it("a gateway token over budget names the gateway and the reset", () => {
    const n = noticeFor(
      ref({
        kind: "gateway",
        label: "Gateway token · LiteLLM",
        scope: "person",
        userId: "u1",
        fixAt: "Settings → My tokens",
      }),
      {
        status: "error",
        reason: "over",
        expiresAt: null,
        details: {},
        overBudget: { spend: 5.1, maxBudget: 5, resetAt: "2026-11-01T00:00:00Z" },
      },
      { kind: "budget.exceeded", markers: [] },
      NOW,
    );
    expect(n.subject).toBe("Your gateway token is over budget");
    expect(n.body).toContain("(LiteLLM) is over its budget: 5.10 of 5.00 USD spent");
    expect(n.body).toContain("2026-11-01 00:00 UTC");
    expect(n.body).toContain("runs fail before they start");
  });

  it("counts a send as done when someone got it, chose not to, or nobody was there", () => {
    expect(delivered({ sent: ["u"], skipped: [] })).toBe(true);
    expect(delivered({ sent: [], skipped: [{ userId: "u", why: "turned off" }] })).toBe(true);
    expect(delivered({ sent: [], skipped: [], error: "No one to send it to" })).toBe(true);
    expect(delivered({ sent: [], skipped: [], error: "Email isn't set up on this Optio" })).toBe(
      false,
    );
    expect(delivered({ sent: [], skipped: [{ userId: "u", why: "550 relay denied" }] })).toBe(
      false,
    );
  });

  it("counts people nothing can reach as no one; someone waiting for the relay keeps it due", () => {
    expect(delivered({ sent: [], skipped: [{ userId: "a", why: NO_ADDRESS }] })).toBe(true);
    expect(delivered({ sent: [], skipped: [{ userId: "a", why: NO_RELAY }] })).toBe(false);
    expect(
      delivered({
        sent: [],
        skipped: [
          { userId: "a", why: NO_ADDRESS },
          { userId: "b", why: "connect ECONNREFUSED" },
        ],
      }),
    ).toBe(false);
    const none = { sent: [], skipped: [], error: "No one to send it to" };
    expect(delivered(mergeResults([none, { sent: ["u1"], skipped: [] }]))).toBe(true);
    expect(mergeResults([none, none])).toEqual(none);
  });
});
