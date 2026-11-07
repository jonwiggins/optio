import { describe, expect, it } from "vitest";
import {
  auditActions,
  auditDetails,
  auditQuery,
  defaultAuditFilters,
  retentionSource,
  type AuditFilters,
} from "./audit";

const base: AuditFilters = {
  workspace: "all",
  userId: "",
  teamId: "",
  group: "",
  action: "",
  from: "",
  to: "",
  outcome: "",
};

describe("audit filters", () => {
  it("open on the last seven days of everything", () => {
    const f = defaultAuditFilters(new Date("2026-10-24T12:00:00Z"));
    expect(f).toMatchObject({ from: "2026-10-17", to: "", userId: "", group: "", outcome: "" });
  });

  it("join a group's prefixes with typed action names", () => {
    expect(auditActions({ group: "merges", action: "" })).toEqual(["pr.merge", "auto_merge"]);
    expect(auditActions({ group: "", action: " team.join , ,auth " })).toEqual([
      "team.join",
      "auth",
    ]);
    expect(auditActions({ group: "nope", action: "" })).toEqual([]);
  });

  it("become one query string for the list and the export", () => {
    const f = {
      ...base,
      userId: "u-1",
      teamId: "t-1",
      group: "sign-in",
      action: "api_key",
      from: "2026-10-01",
      to: "2026-10-24",
      outcome: "failure" as const,
    };
    const q = new URLSearchParams(auditQuery(f, { scoped: true, limit: 100, offset: 200 }));
    expect(Object.fromEntries(q)).toEqual({
      workspace: "all",
      userId: "u-1",
      teamId: "t-1",
      action: "auth,api_key",
      from: "2026-10-01",
      to: "2026-10-24",
      outcome: "failure",
      limit: "100",
      offset: "200",
    });
    expect(auditQuery(base, { format: "jsonl" })).toBe("format=jsonl");
    // A workspace admin can't pick the workspace: the query doesn't ask.
    expect(auditQuery({ ...base, workspace: "current" })).toBe("");
  });
});

describe("audit details", () => {
  it("name known people and teams, in a stable order", () => {
    const rows = auditDetails(
      { teamId: "t-1", targetUserId: "u-2", extra: 1, empty: "" },
      { people: { "u-2": "Bob" }, teams: { "t-1": "Platform" } },
    );
    expect(rows).toEqual([
      { key: "targetUserId", label: "Person", text: "Bob" },
      { key: "teamId", label: "Team", text: "Platform" },
      { key: "extra", label: "extra", text: "1" },
    ]);
  });

  it("show ids they can't name, and lists as text", () => {
    expect(auditDetails({ confirmedBy: "u-9", fields: ["a", "b"] })).toEqual([
      { key: "fields", label: "Changed", text: "a, b" },
      { key: "confirmedBy", label: "Confirmed by", text: "u-9" },
    ]);
  });

  it("say where the retention comes from", () => {
    const r = {
      days: 365,
      environmentDays: 365,
      lastPrunedAt: null,
      updatedAt: null,
      updatedBy: null,
    };
    expect(retentionSource({ ...r, source: "app" })).toMatch(/deployment admin/);
    expect(retentionSource({ ...r, source: "environment" })).toMatch(/OPTIO_AUDIT_RETENTION_DAYS/);
    expect(retentionSource({ ...r, source: "default" })).toBe("the default");
  });
});
