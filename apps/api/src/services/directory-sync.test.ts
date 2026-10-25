/**
 * The directory sync's rules without a database (services/directory-sync.ts):
 * what an entry means for a person, when a run is held, the settings'
 * environment defaults. The runs themselves are in directory-sync.int.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));

import type { LdapUser } from "./auth/ldap.js";
import {
  DEFAULT_INTERVAL_MINUTES,
  FILTER_UNKNOWN,
  envDirectorySync,
  sameEntry,
  shouldHold,
  validInterval,
  verdictFor,
} from "./directory-sync.js";

function entry(over: Partial<LdapUser> = {}): LdapUser {
  return {
    dn: "uid=carol,ou=people,dc=corp,dc=test",
    externalId: "8f1c-carol",
    username: "carol",
    email: "carol@example.test",
    displayName: "Carol Cohen",
    groups: ["developers"],
    groupDns: ["cn=developers,ou=groups,dc=corp,dc=test"],
    accountDisabled: false,
    ...over,
  };
}

const carol = { externalId: "8f1c-carol" };
const open = { allowedDomains: [], settings: {} };

describe("verdictFor", () => {
  it("keeps a person whose entry is there and who passes the sign-in rule", () => {
    const v = verdictFor(carol, entry(), {
      allowedDomains: ["example.test"],
      settings: { requiredGroups: ["Developers"] },
    });
    expect(v.kind).toBe("active");
  });

  it("calls a missing entry gone", () => {
    expect(verdictFor(carol, null, open)).toEqual({ kind: "leaver", reason: "gone" });
  });

  it("calls an entry that now belongs to someone else gone", () => {
    expect(verdictFor(carol, entry({ externalId: "another-person" }), open)).toEqual({
      kind: "leaver",
      reason: "gone",
    });
  });

  it("reads Active Directory's disabled flag", () => {
    expect(verdictFor(carol, entry({ accountDisabled: true }), open)).toEqual({
      kind: "leaver",
      reason: "disabled_in_directory",
    });
  });

  it("calls someone outside every required group a leaver, case-insensitively", () => {
    const settings = { requiredGroups: ["optio-users"] };
    expect(verdictFor(carol, entry(), { allowedDomains: [], settings })).toEqual({
      kind: "leaver",
      reason: "not_in_required_group",
    });
    expect(
      verdictFor(carol, entry({ groups: ["OPTIO-USERS"] }), { allowedDomains: [], settings }).kind,
    ).toBe("active");
  });

  it("calls an email domain no longer allowed a leaver (and a missing email too)", () => {
    const cfg = { allowedDomains: ["example.org"], settings: {} };
    expect(verdictFor(carol, entry(), cfg)).toEqual({
      kind: "leaver",
      reason: "domain_not_allowed",
    });
    expect(
      verdictFor(carol, entry({ email: "" }), { ...cfg, allowedDomains: ["example.test"] }),
    ).toEqual({ kind: "leaver", reason: "domain_not_allowed" });
  });

  it("calls an entry the user filter no longer finds gone: a sign-in can't reach it", () => {
    expect(verdictFor(carol, { ...entry(), userFilter: "excludes" }, open)).toEqual({
      kind: "leaver",
      reason: "gone",
    });
    // Active Directory's own flag says more, when it is set too.
    expect(
      verdictFor(carol, { ...entry({ accountDisabled: true }), userFilter: "excludes" }, open),
    ).toEqual({ kind: "leaver", reason: "disabled_in_directory" });
  });

  it("leaves someone it can't judge against the user filter unchecked, never a leaver", () => {
    expect(verdictFor(carol, { ...entry(), userFilter: "unknown" }, open)).toEqual({
      kind: "unchecked",
      why: FILTER_UNKNOWN,
    });
    expect(verdictFor(carol, { ...entry(), userFilter: "selects" }, open).kind).toBe("active");
  });
});

describe("sameEntry", () => {
  it("matches the stored identity, or the DN where the directory had no GUID", () => {
    expect(sameEntry("8f1c-carol", entry())).toBe(true);
    expect(sameEntry("UID=carol,OU=people,DC=corp,DC=test", entry())).toBe(true);
    expect(sameEntry("someone-else", entry())).toBe(false);
  });
});

describe("shouldHold", () => {
  it("lets up to three people go however few were checked", () => {
    expect(shouldHold(2, 2, 25)).toBe(false);
    expect(shouldHold(4, 3, 25)).toBe(false);
    expect(shouldHold(4, 4, 25)).toBe(true);
  });

  it("holds past the percentage on a bigger directory", () => {
    expect(shouldHold(100, 25, 25)).toBe(false);
    expect(shouldHold(100, 26, 25)).toBe(true);
  });

  it("never holds at 100 percent", () => {
    expect(shouldHold(10, 10, 100)).toBe(false);
  });
});

describe("settings from the environment", () => {
  it("is off, every 30 minutes, 25 percent, when nothing is set", () => {
    expect(envDirectorySync({})).toEqual({
      enabled: false,
      intervalMinutes: DEFAULT_INTERVAL_MINUTES,
      maxDisablePercent: 25,
    });
  });

  it("reads the chart's values", () => {
    expect(
      envDirectorySync({
        OPTIO_DIRECTORY_SYNC: "true",
        OPTIO_DIRECTORY_SYNC_INTERVAL_MINUTES: "60",
        OPTIO_DIRECTORY_SYNC_MAX_DISABLE_PERCENT: "10",
      }),
    ).toEqual({ enabled: true, intervalMinutes: 60, maxDisablePercent: 10 });
  });

  it("ignores an interval out of bounds and clamps the percentage", () => {
    const e = envDirectorySync({
      OPTIO_DIRECTORY_SYNC_INTERVAL_MINUTES: "5",
      OPTIO_DIRECTORY_SYNC_MAX_DISABLE_PERCENT: "250",
    });
    expect(e.intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
    expect(e.maxDisablePercent).toBe(100);
  });

  it("validInterval takes whole minutes from 15 to 1440", () => {
    expect(validInterval(15)).toBe(15);
    expect(validInterval("1440")).toBe(1440);
    expect(validInterval(14)).toBeNull();
    expect(validInterval(30.5)).toBeNull();
    expect(validInterval("soon")).toBeNull();
    expect(validInterval(undefined)).toBeNull();
  });
});
