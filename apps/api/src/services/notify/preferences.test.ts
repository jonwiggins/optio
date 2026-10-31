import { describe, expect, it } from "vitest";
import { emailByDefault, kindInfo, NOTIFY_KINDS } from "./kinds.js";
import { mergeChoices, wantsEmail } from "./preferences.js";

describe("notification choices", () => {
  it("emails what needs the person by default, not a merge", () => {
    const c = mergeChoices(undefined);
    // Every listed kind has a default (other fork kinds are added beside these).
    expect(Object.keys(c.email).sort()).toEqual(NOTIFY_KINDS.map((k) => k.kind).sort());
    expect(c.email).toMatchObject({
      "task.pr_opened": true,
      "task.needs_attention": true,
      "task.failed": true,
      "task.completed": false,
      // An admin is told when someone in their workspace or team leaves (offboarding.ts).
      "user.offboarded": true,
    });
    expect(c.email["budget.warning"]).toBeUndefined();
    expect(c.email["directory.sync_stopped"]).toBe(true);
    expect(c.teamWork).toBe(true);
    // Push follows upstream's defaults for the same keys.
    expect(c.push["task.pr_opened"]).toBe(true);
  });

  it("reads email from channels and push from upstream's preferences", () => {
    const c = mergeChoices({
      preferences: { "task.failed": { push: false } },
      channels: { email: { "task.failed": false, "budget.warning": false }, teamWork: false },
    });
    expect(c.email["task.failed"]).toBe(false);
    expect(c.push["task.failed"]).toBe(false);
    // A kind someone chose for that isn't listed keeps the choice.
    expect(c.email["budget.warning"]).toBe(false);
    expect(c.teamWork).toBe(false);
  });

  it("lets a team admin turn off their teams' work but not their own", () => {
    const c = mergeChoices({ preferences: {}, channels: { teamWork: false } });
    expect(wantsEmail(c, "task.failed", { why: "owner" })).toBe(true);
    expect(wantsEmail(c, "task.failed", { why: "team-admin", teamName: "Platform" })).toBe(false);
    // A notice addressed to a team's admins isn't "their teams' work".
    expect(wantsEmail(c, "task.failed", { why: "team", teamName: "Platform" })).toBe(true);
  });

  it("emails a kind nobody listed (so nobody can miss a new notice)", () => {
    const c = mergeChoices(undefined);
    expect(wantsEmail(c, "offboarding.notice", { why: "addressed" })).toBe(true);
    expect(emailByDefault("offboarding.notice")).toBe(true);
    expect(kindInfo("offboarding.notice")).toBeNull();
  });

  it("has a label and a description for every kind it lists", () => {
    for (const k of NOTIFY_KINDS) {
      expect(k.label.length).toBeGreaterThan(2);
      expect(k.description.length).toBeGreaterThan(10);
    }
  });

  it("lists each kind once (packages that share a kind keep one entry)", () => {
    const kinds = NOTIFY_KINDS.map((k) => k.kind);
    expect(kinds.length).toBe(new Set(kinds).size);
  });
});
