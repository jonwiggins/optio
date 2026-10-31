/**
 * What a person's new gateway key carries over from the keys before it
 * (gateway-key-carry.ts): each amount until its own key's period ends, so
 * spend never piles up across rotations.
 */
import { describe, expect, it } from "vitest";
import {
  budgetPeriodOpen,
  carriedOf,
  carriedTotal,
  carryAfter,
  carryDue,
  periodEndAt,
  type CarriedSpend,
} from "./gateway-key-carry.js";

const DAY = 86_400_000;
const T0 = new Date("2026-10-01T00:00:00Z").getTime();
const day = (n: number) => new Date(T0 + n * DAY);

describe("a key's budget period", () => {
  it("knows when it is over", () => {
    const now = new Date("2026-10-24T12:00:00Z");
    const created = new Date("2026-10-20T00:00:00Z");
    const open = (budgetResetAt: string | null, budgetDuration: string | null) =>
      budgetPeriodOpen({ budgetResetAt, budgetDuration, createdAt: created }, now);
    expect(open("2026-10-30T00:00:00Z", "30d")).toBe(true);
    expect(open("2026-10-24T11:00:00Z", "30d")).toBe(false);
    // No reset recorded: from when the key was made.
    expect(open(null, "30d")).toBe(true);
    expect(open(null, "1d")).toBe(false);
    // A budget that never resets is always running.
    expect(open(null, null)).toBe(true);
  });

  it("finds the period running at a time, however many have passed", () => {
    expect(periodEndAt(day(0), "30d", day(10))).toEqual(day(30));
    expect(periodEndAt(day(0), "30d", day(30))).toEqual(day(60));
    expect(periodEndAt(day(0), "30d", day(75))).toEqual(day(90));
    expect(periodEndAt(day(0), null, day(75))).toBeNull();
  });
});

describe("what a new key carries", () => {
  const key = (createdAt: Date, carriedSpend: CarriedSpend[] | null = null) => ({
    createdAt,
    budgetDuration: "30d",
    carriedSpend,
  });

  it("the old key's own spend, until the old key's period ends", () => {
    // 5 USD per 30 days; key A made on day 0, rotated on day 25 with 4.9 spent.
    const carry = carryAfter(
      key(day(0)),
      { spend: 4.9, resetAt: day(30), readAt: day(25) },
      day(25),
    );
    expect(carry).toEqual([{ usd: 4.9, until: day(30).toISOString() }]);
    expect(carriedTotal(carry)).toBe(4.9);
  });

  it("nothing once the old key's period is over", () => {
    expect(
      carryAfter(key(day(0)), { spend: 4.9, resetAt: day(30), readAt: day(20) }, day(31)),
    ).toEqual([]);
    // Without a reset time from LiteLLM: from when the key was made.
    expect(carryAfter(key(day(0)), { spend: 2, resetAt: null, readAt: day(20) }, day(25))).toEqual([
      { usd: 2, until: day(30).toISOString() },
    ]);
  });

  it("an amount the old key carried keeps its own end, apart from the old key's own spend", () => {
    // B (made day 10) carries 3 from A until day 30, and spent 1 itself.
    const b = key(day(10), [{ usd: 3, until: day(30).toISOString() }]);
    const carry = carryAfter(b, { spend: 4, resetAt: day(40), readAt: day(20) }, day(20));
    expect(carry).toEqual([
      { usd: 3, until: day(30).toISOString() },
      { usd: 1, until: day(40).toISOString() },
    ]);
    // Read after A's amount ended: only B's own spend goes on.
    expect(carryAfter(b, { spend: 4, resetAt: day(40), readAt: day(20) }, day(32))).toEqual([
      { usd: 1, until: day(40).toISOString() },
    ]);
  });

  it("a key given up: its saved spend, read when it went", () => {
    // Given up on day 20 with 4 spent (3 of it carried until day 30); a key got on day 35.
    const b = key(day(10), [{ usd: 3, until: day(30).toISOString() }]);
    expect(carryAfter(b, { spend: 4, resetAt: day(40), readAt: day(20) }, day(35))).toEqual([
      { usd: 1, until: day(40).toISOString() },
    ]);
  });

  it("an old key LiteLLM already reset no longer has its carried amounts in its spend", () => {
    // B made day 10 carried 3 until day 30; on day 41 LiteLLM had reset B (day 40).
    const b = key(day(10), [{ usd: 3, until: day(30).toISOString() }]);
    expect(carryAfter(b, { spend: 0.5, resetAt: day(70), readAt: day(41) }, day(41))).toEqual([
      { usd: 0.5, until: day(70).toISOString() },
    ]);
  });

  it("a budget that never resets carries for good", () => {
    const k = { createdAt: day(0), budgetDuration: null, carriedSpend: null };
    expect(carryAfter(k, { spend: 2, resetAt: null, readAt: day(5) }, day(400))).toEqual([
      { usd: 2, until: null },
    ]);
    expect(carryDue({ ...k, carriedSpend: [{ usd: 2, until: null }] }, day(900))).toBeNull();
  });

  it("drops garbage from a stored value", () => {
    expect(
      carriedOf([
        { usd: 1, until: day(3).toISOString() },
        { usd: -1, until: null },
        { usd: "x", until: null },
        { usd: 2, until: "not a date" },
        null,
        { usd: 0.5, until: null },
      ]),
    ).toEqual([
      { usd: 1, until: day(3).toISOString() },
      { usd: 0.5, until: null },
    ]);
    expect(carriedOf("nope")).toEqual([]);
  });
});

describe("what the check takes off", () => {
  it("each amount once its period is over, keeping the rest", () => {
    const k = {
      createdAt: day(20),
      budgetDuration: "30d",
      carriedSpend: [
        { usd: 3, until: day(30).toISOString() },
        { usd: 1, until: day(40).toISOString() },
      ],
    };
    expect(carryDue(k, day(29))).toBeNull();
    expect(carryDue(k, day(30))).toEqual({
      takeOff: 3,
      keep: [{ usd: 1, until: day(40).toISOString() }],
    });
    expect(carryDue(k, day(45))).toEqual({ takeOff: 4, keep: [] });
  });

  it("nothing once LiteLLM started the key's own period over: the amounts went with it", () => {
    const k = {
      createdAt: day(0),
      budgetDuration: "30d",
      carriedSpend: [{ usd: 3, until: day(20).toISOString() }],
    };
    expect(carryDue(k, day(31))).toEqual({ takeOff: 0, keep: [] });
    expect(carryDue({ ...k, carriedSpend: null }, day(31))).toBeNull();
  });
});

/**
 * A person spending every day, rotating every `every` days, against a
 * LiteLLM that resets each key `period` days after it was made and an Optio
 * check that runs daily. Answers the most the key's spend ever exceeded what
 * the person spent in the last `period` days (0 = never).
 */
function simulate(opts: { days: number; every: number; daily: number; period?: number }) {
  const period = opts.period ?? 30;
  const duration = `${period}d`;
  const spentOn: number[] = [];
  let k = {
    createdAt: day(0),
    budgetDuration: duration,
    carriedSpend: null as CarriedSpend[] | null,
    spend: 0,
    resetAt: day(period),
  };
  let worst = 0;
  let highest = 0;
  for (let d = 0; d < opts.days; d++) {
    const now = day(d);
    // LiteLLM's own reset.
    while (k.resetAt.getTime() <= now.getTime()) {
      k.spend = 0;
      k.resetAt = new Date(k.resetAt.getTime() + period * DAY);
    }
    // Optio's check.
    const due = carryDue(k, now);
    if (due) {
      k.spend = Math.max(0, k.spend - due.takeOff);
      k.carriedSpend = due.keep;
    }
    // Rotate.
    if (d > 0 && d % opts.every === 0) {
      const carry = carryAfter(k, { spend: k.spend, resetAt: k.resetAt, readAt: now }, now);
      k = {
        createdAt: now,
        budgetDuration: duration,
        carriedSpend: carry,
        spend: carriedTotal(carry),
        resetAt: day(d + period),
      };
    }
    k.spend += opts.daily;
    spentOn[d] = opts.daily;
    const window = spentOn.slice(Math.max(0, d - period + 1), d + 1).reduce((a, b) => a + b, 0);
    worst = Math.max(worst, k.spend - window);
    highest = Math.max(highest, k.spend);
  }
  return { worst, highest };
}

describe("rotating never piles spend up", () => {
  it("the reviewer's case: rotating on day 25, then on day 50", () => {
    // 4.9 spent on day 1 with key A; rotated on day 25; A's period ends day 30.
    const a = { createdAt: day(0), budgetDuration: "30d", carriedSpend: null };
    const b = carryAfter(a, { spend: 4.9, resetAt: day(30), readAt: day(25) }, day(25));
    let bSpend = carriedTotal(b) + 0.1; // B spends 0.1 itself
    const due = carryDue({ createdAt: day(25), budgetDuration: "30d", carriedSpend: b }, day(30));
    expect(due).toEqual({ takeOff: 4.9, keep: [] });
    bSpend -= due!.takeOff;
    expect(bSpend).toBeCloseTo(0.1);
    // Rotated again on day 50: C carries B's own 0.1 until day 55, not 5.0.
    const c = carryAfter(
      { createdAt: day(25), budgetDuration: "30d", carriedSpend: [] },
      { spend: bSpend, resetAt: day(55), readAt: day(50) },
      day(50),
    );
    expect(carriedTotal(c)).toBeCloseTo(0.1);
    expect(c[0].until).toBe(day(55).toISOString());
  });

  for (const every of [1, 7, 10, 25, 29, 31, 45]) {
    it(`rotating every ${every} days for a year: the spend never counts more than the last 30 days`, () => {
      const { worst, highest } = simulate({ days: 365, every, daily: 0.1 });
      expect(worst).toBeLessThanOrEqual(1e-6);
      // 30 days at 0.1 a day, at most.
      expect(highest).toBeLessThanOrEqual(3 + 1e-6);
    });
  }
});
