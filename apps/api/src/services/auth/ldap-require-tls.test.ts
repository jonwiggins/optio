import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const client = {
    bind: vi.fn(),
    startTLS: vi.fn(),
    search: vi.fn(),
    unbind: vi.fn(),
  };
  const construct = vi.fn();
  class Client {
    constructor(options: unknown) {
      construct(options);
      return client;
    }
  }
  return { client, construct, Client };
});

vi.mock("ldapts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ldapts")>();
  return { ...actual, Client: mocks.Client };
});

import { LdapAuthError, ldapAuthenticate, ldapTest, type LdapSettings } from "./ldap.js";
import { ldapPlainTransportRefused } from "../../utils/idp-url.js";

const BASE: LdapSettings = {
  url: "ldap://ad.example.com:389",
  bindDn: "CN=svc-optio,OU=Service,DC=example,DC=com",
  bindPassword: "svc-password",
  userBaseDn: "DC=example,DC=com",
};
const ALICE = {
  dn: "CN=Alice,OU=People,DC=example,DC=com",
  sAMAccountName: "alice",
  mail: "alice@example.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.client.bind.mockResolvedValue(undefined);
  mocks.client.startTLS.mockResolvedValue(undefined);
  mocks.client.unbind.mockResolvedValue(undefined);
  mocks.client.search.mockResolvedValue({ searchEntries: [ALICE], searchReferences: [] });
});
afterEach(() => vi.unstubAllEnvs());

describe("OPTIO_LDAP_REQUIRE_TLS", () => {
  it("is off by default: plain ldap:// still signs in", async () => {
    vi.stubEnv("OPTIO_LDAP_REQUIRE_TLS", "");
    const user = await ldapAuthenticate(BASE, "alice", "pw");
    expect(user.username).toBe("alice");
    expect(mocks.client.bind).toHaveBeenCalledWith(BASE.bindDn, BASE.bindPassword);
  });

  it("refuses plain ldap:// before connecting, so no password is sent", async () => {
    vi.stubEnv("OPTIO_LDAP_REQUIRE_TLS", "true");
    const err = await ldapAuthenticate(BASE, "alice", "pw").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LdapAuthError);
    expect((err as LdapAuthError).code).toBe("config");
    expect((err as LdapAuthError).message).toMatch(/requires TLS for LDAP.*ldaps:\/\/.*STARTTLS/);
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.client.bind).not.toHaveBeenCalled();
  });

  it("refuses plain ldap:// in a test connection too", async () => {
    vi.stubEnv("OPTIO_LDAP_REQUIRE_TLS", "true");
    const result = await ldapTest(BASE);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/OPTIO_LDAP_REQUIRE_TLS/);
    expect(mocks.construct).not.toHaveBeenCalled();
  });

  it("allows ldap:// with STARTTLS, upgraded before the bind", async () => {
    vi.stubEnv("OPTIO_LDAP_REQUIRE_TLS", "true");
    await ldapAuthenticate({ ...BASE, startTls: true }, "alice", "pw");
    expect(mocks.client.startTLS).toHaveBeenCalledTimes(1);
    expect(mocks.client.startTLS.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.client.bind.mock.invocationCallOrder[0],
    );
  });

  it("allows ldaps:// with a private CA", async () => {
    vi.stubEnv("OPTIO_LDAP_REQUIRE_TLS", "true");
    const caPem = "-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----";
    await ldapAuthenticate({ ...BASE, url: "ldaps://ad.example.com:636", caPem }, "alice", "pw");
    expect(mocks.construct).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ldaps://ad.example.com:636", tlsOptions: { ca: [caPem] } }),
    );
  });

  it("matches the scheme without regard to case or surrounding space", () => {
    vi.stubEnv("OPTIO_LDAP_REQUIRE_TLS", "true");
    expect(ldapPlainTransportRefused({ url: " LDAP://ad.example.com " })).toBe(true);
    expect(ldapPlainTransportRefused({ url: "LDAPS://ad.example.com" })).toBe(false);
    expect(ldapPlainTransportRefused({ url: "ldap://ad.example.com", startTls: true })).toBe(false);
  });

  it("is read like every other sign-in switch: true, 1 or yes, any case, trimmed", () => {
    for (const on of ["1", "yes", "TRUE", " True ", "Yes"]) {
      vi.stubEnv("OPTIO_LDAP_REQUIRE_TLS", on);
      expect(ldapPlainTransportRefused({ url: "ldap://ad.example.com" }), on).toBe(true);
    }
    for (const off of ["false", "0", "no", "", "  ", "enabled"]) {
      vi.stubEnv("OPTIO_LDAP_REQUIRE_TLS", off);
      expect(ldapPlainTransportRefused({ url: "ldap://ad.example.com" }), off).toBe(false);
    }
  });
});
