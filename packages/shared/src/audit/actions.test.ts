import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTION_GROUPS,
  AUDIT_ACTION_LABELS,
  auditActionLabel,
  auditActionMatches,
} from "./actions.js";

describe("the audit catalog", () => {
  it("matches an action or a prefix of whole segments", () => {
    expect(auditActionMatches("team.join.approve", "team")).toBe(true);
    expect(auditActionMatches("team.join.approve", "team.join")).toBe(true);
    expect(auditActionMatches("team.join.approve", "team.join.")).toBe(true);
    expect(auditActionMatches("team.join", "team.join")).toBe(true);
    expect(auditActionMatches("team.joined", "team.join")).toBe(false);
    expect(auditActionMatches("teams.create", "team")).toBe(false);
    expect(auditActionMatches("anything", "")).toBe(true);
  });

  it("names known actions and falls back to the action itself", () => {
    expect(auditActionLabel("auth.sign_in")).toBe("Signed in");
    expect(auditActionLabel("task.retry")).toBe("task.retry");
  });

  it("every filter group matches at least one catalogued action", () => {
    for (const group of AUDIT_ACTION_GROUPS) {
      const hit = Object.keys(AUDIT_ACTION_LABELS).some((a) =>
        group.prefixes.some((p) => auditActionMatches(a, p)),
      );
      expect(hit, group.id).toBe(true);
    }
  });
});
