import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("../db/client.js", () => ({
  db: { select: () => ({ from: () => ({ where: () => lookup() }) }) },
}));

import {
  auditLine,
  auditStdoutEnabled,
  emitAuditLine,
  resetAuditStdoutCache,
  setAuditStdoutWriterForTests,
} from "./audit-stdout.js";

const row = {
  id: "a-1",
  workspaceId: "ws-1",
  userId: "u-1",
  action: "auth.sign_in",
  params: { provider: "ldap", via: "cli" },
  success: true,
  clientIp: "10.0.0.5",
  createdAt: new Date("2026-10-24T09:12:03.120Z"),
};

let lines: string[];
let restore: (line: string) => void;

beforeEach(() => {
  lines = [];
  restore = setAuditStdoutWriterForTests((l) => lines.push(l));
  resetAuditStdoutCache();
  lookup.mockReset().mockResolvedValue([{ email: "carol@example.test", name: "Carol" }]);
});
afterEach(() => {
  setAuditStdoutWriterForTests(restore);
  vi.unstubAllEnvs();
});

describe("audit entries on stdout", () => {
  it("is on only with OPTIO_AUDIT_STDOUT=json", () => {
    expect(auditStdoutEnabled({})).toBe(false);
    expect(auditStdoutEnabled({ OPTIO_AUDIT_STDOUT: "text" })).toBe(false);
    expect(auditStdoutEnabled({ OPTIO_AUDIT_STDOUT: " JSON " })).toBe(true);
  });

  it("writes nothing when off", async () => {
    await emitAuditLine(row);
    expect(lines).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("writes one JSON line per entry, with the actor's email and name", async () => {
    vi.stubEnv("OPTIO_AUDIT_STDOUT", "json");
    await emitAuditLine(row);
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith("\n")).toBe(true);
    expect(lines[0].trim().includes("\n")).toBe(false);
    expect(JSON.parse(lines[0])).toEqual({
      type: "optio.audit",
      version: 1,
      time: "2026-10-24T09:12:03.120Z",
      id: "a-1",
      action: "auth.sign_in",
      success: true,
      workspaceId: "ws-1",
      actor: { id: "u-1", email: "carol@example.test", name: "Carol" },
      clientIp: "10.0.0.5",
      details: { provider: "ldap", via: "cli" },
    });
  });

  it("looks a person up once for a burst of entries", async () => {
    vi.stubEnv("OPTIO_AUDIT_STDOUT", "json");
    await emitAuditLine(row);
    await emitAuditLine({ ...row, id: "a-2" });
    expect(lines).toHaveLength(2);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("still writes the line when the lookup fails, and an entry with no actor", async () => {
    vi.stubEnv("OPTIO_AUDIT_STDOUT", "json");
    lookup.mockRejectedValue(new Error("db down"));
    await emitAuditLine(row);
    await emitAuditLine({ ...row, userId: null, action: "auth.sign_in.failure", success: false });
    expect(JSON.parse(lines[0]).actor).toEqual({ id: "u-1", email: null, name: null });
    expect(JSON.parse(lines[1]).actor).toBeNull();
  });

  it("ignores a missing row (a mocked insert)", async () => {
    vi.stubEnv("OPTIO_AUDIT_STDOUT", "json");
    await emitAuditLine(undefined);
    expect(lines).toEqual([]);
  });

  it("builds the line from the stored row alone", () => {
    expect(auditLine({ ...row, params: null, clientIp: null }, null)).toMatchObject({
      details: {},
      clientIp: null,
      actor: { id: "u-1", email: null, name: null },
    });
  });
});
