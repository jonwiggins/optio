import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── ldapts mock: real filters + error classes, fake Client ───

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
      return client as unknown as Client;
    }
  }
  return { client, construct, Client };
});

vi.mock("ldapts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ldapts")>();
  return { ...actual, Client: mocks.Client };
});

import {
  EqualityFilter,
  InvalidCredentialsError,
  NoSuchObjectError,
  SizeLimitExceededError,
} from "ldapts";
import {
  LdapAuthError,
  escapeLdapFilterValue,
  groupNameFromDn,
  isAccountDisabled,
  ldapAuthenticate,
  objectGuidBytes,
  openLdapDirectory,
  ldapSearchGroups,
  ldapTest,
  renderLdapFilter,
  usernameKeys,
  type LdapSettings,
} from "./ldap.js";

// ─── Fixtures ───

const SVC_DN = "CN=svc-optio,OU=Service,DC=corp,DC=example";
const BASE_DN = "DC=corp,DC=example";
const ALICE_DN = "CN=Alice Smith,OU=People,DC=corp,DC=example";
const DEVELOPERS_DN = "CN=Developers,OU=Groups,DC=corp,DC=example";
const DEV_TEAM_DN = "CN=Dev\\, Team,OU=Groups,DC=corp,DC=example";
const GUID_BYTES = Buffer.from([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
]);
/** GUID_BYTES as Optio stores it (externalIdFor). */
const ALICE_GUID = "04030201-0605-0807-090a-0b0c0d0e0f10";
const CAROL_UUID = "5d6a2c1e-0b7f-4c3e-9a51-2f8e6d4c3b2a";
const DAVE_UUID = "7e1b3d5f-2a4c-4e6a-8c0e-1f3a5b7d9e0c";

const SETTINGS: LdapSettings = {
  url: "ldaps://ad.example.com:636",
  bindDn: SVC_DN,
  bindPassword: "svc-secret",
  userBaseDn: BASE_DN,
};

function aliceEntry(overrides: Record<string, unknown> = {}) {
  return {
    dn: ALICE_DN,
    sAMAccountName: "alice",
    mail: "alice@example.com",
    displayName: "Alice Smith",
    objectGUID: GUID_BYTES,
    memberOf: [DEVELOPERS_DN, DEV_TEAM_DN, DEVELOPERS_DN],
    ...overrides,
  };
}

function found(entries: unknown[]) {
  return { searchEntries: entries, searchReferences: [] };
}

function connectionRefused() {
  return Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:636"), { code: "ECONNREFUSED" });
}

async function expectLdapError(
  promise: Promise<unknown>,
  code: LdapAuthError["code"],
): Promise<LdapAuthError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(LdapAuthError);
    expect((err as LdapAuthError).code).toBe(code);
    return err as LdapAuthError;
  }
  throw new Error(`expected an LdapAuthError with code ${code}`);
}

function constructorOptions(): Record<string, unknown> {
  expect(mocks.construct).toHaveBeenCalledTimes(1);
  return mocks.construct.mock.calls[0]![0] as Record<string, unknown>;
}

function searchOptions(call: number): Record<string, unknown> {
  return mocks.client.search.mock.calls[call]![1] as Record<string, unknown>;
}

beforeEach(() => {
  mocks.construct.mockReset();
  mocks.client.bind.mockReset().mockResolvedValue(undefined);
  mocks.client.startTLS.mockReset().mockResolvedValue(undefined);
  mocks.client.unbind.mockReset().mockResolvedValue(undefined);
  mocks.client.search.mockReset().mockResolvedValue(found([]));
});

// ─── ldapAuthenticate ───

describe("ldapAuthenticate", () => {
  it("signs in and reads groups from memberOf", async () => {
    mocks.client.search.mockResolvedValueOnce(found([aliceEntry()]));

    const user = await ldapAuthenticate(SETTINGS, "alice", "correct horse");

    expect(user).toEqual({
      dn: ALICE_DN,
      externalId: "04030201-0605-0807-090a-0b0c0d0e0f10",
      username: "alice",
      email: "alice@example.com",
      displayName: "Alice Smith",
      groups: ["Developers", "Dev, Team"],
      groupDns: [DEVELOPERS_DN, DEV_TEAM_DN],
      accountDisabled: false,
    });

    expect(constructorOptions()).toEqual({
      url: "ldaps://ad.example.com:636",
      timeout: 10_000,
      connectTimeout: 10_000,
    });
    expect(mocks.client.startTLS).not.toHaveBeenCalled();
    expect(mocks.client.bind.mock.calls).toEqual([
      [SVC_DN, "svc-secret"],
      [ALICE_DN, "correct horse"],
    ]);
    expect(mocks.client.search).toHaveBeenCalledTimes(1);
    expect(mocks.client.search).toHaveBeenCalledWith(
      BASE_DN,
      expect.objectContaining({
        scope: "sub",
        filter: "(|(sAMAccountName=alice)(uid=alice)(mail=alice))",
        sizeLimit: 2,
        explicitBufferAttributes: ["objectGUID"],
      }),
    );
    expect(searchOptions(0).attributes).toEqual(
      expect.arrayContaining([
        "sAMAccountName",
        "uid",
        "mail",
        "displayName",
        "cn",
        "objectGUID",
        "entryUUID",
        "userAccountControl",
        "memberOf",
      ]),
    );
    expect(mocks.client.unbind).toHaveBeenCalledTimes(1);
  });

  it("escapes the username inside the user filter", async () => {
    mocks.client.search.mockResolvedValueOnce(found([aliceEntry()]));

    await ldapAuthenticate(SETTINGS, "al*ice)", "pw");

    expect(searchOptions(0).filter).toBe(
      "(|(sAMAccountName=al\\2aice\\29)(uid=al\\2aice\\29)(mail=al\\2aice\\29))",
    );
  });

  it("reads groups with a second search in groupMode search", async () => {
    const groupBase = "OU=Groups,DC=corp,DC=example";
    mocks.client.search
      .mockResolvedValueOnce(found([aliceEntry({ memberOf: undefined })]))
      .mockResolvedValueOnce(
        found([
          { dn: DEVELOPERS_DN, cn: "Developers" },
          { dn: "CN=Ops,OU=Groups,DC=corp,DC=example", cn: ["Ops"] },
          { dn: "CN=From DN,OU=Groups,DC=corp,DC=example", cn: [] },
          { dn: DEVELOPERS_DN, cn: "Developers" },
        ]),
      );

    const user = await ldapAuthenticate(
      { ...SETTINGS, groupMode: "search", groupBaseDn: groupBase },
      "alice",
      "pw",
    );

    expect(user.groups).toEqual(["Developers", "Ops", "From DN"]);
    expect(user.groupDns).toEqual([
      DEVELOPERS_DN,
      "CN=Ops,OU=Groups,DC=corp,DC=example",
      "CN=From DN,OU=Groups,DC=corp,DC=example",
    ]);
    expect(mocks.client.search).toHaveBeenCalledTimes(2);
    expect(mocks.client.search).toHaveBeenNthCalledWith(
      2,
      groupBase,
      expect.objectContaining({
        scope: "sub",
        filter: `(|(member=${ALICE_DN})(uniqueMember=${ALICE_DN})(memberUid=alice))`,
        attributes: ["cn"],
        sizeLimit: 500,
      }),
    );
    // The password bind happens before groups are read, and groups are read as the service account.
    expect(mocks.client.bind.mock.calls).toEqual([
      [SVC_DN, "svc-secret"],
      [ALICE_DN, "pw"],
      [SVC_DN, "svc-secret"],
    ]);
    // memberOf isn't requested when groups come from a search.
    expect(searchOptions(0).attributes).not.toContain("memberOf");
  });

  it("defaults the group base DN to the user base DN", async () => {
    mocks.client.search
      .mockResolvedValueOnce(found([aliceEntry()]))
      .mockResolvedValueOnce(found([]));

    const user = await ldapAuthenticate({ ...SETTINGS, groupMode: "search" }, "alice", "pw");

    expect(user.groups).toEqual([]);
    expect(mocks.client.search.mock.calls[1]![0]).toBe(BASE_DN);
  });

  it("maps a wrong password to invalid_credentials", async () => {
    mocks.client.search.mockResolvedValueOnce(found([aliceEntry()]));
    mocks.client.bind
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new InvalidCredentialsError());

    const err = await expectLdapError(
      ldapAuthenticate(SETTINGS, "alice", "nope"),
      "invalid_credentials",
    );

    expect(err.message).toBe("Wrong username or password");
    expect(mocks.client.unbind).toHaveBeenCalledTimes(1);
  });

  it("maps an unknown user to user_not_found with the same message", async () => {
    const err = await expectLdapError(ldapAuthenticate(SETTINGS, "nobody", "pw"), "user_not_found");

    expect(err.message).toBe("Wrong username or password");
    // Only the service bind ran — nothing to bind the user as.
    expect(mocks.client.bind).toHaveBeenCalledTimes(1);
    expect(mocks.client.unbind).toHaveBeenCalledTimes(1);
  });

  it("treats more than one match as a config problem", async () => {
    mocks.client.search.mockResolvedValueOnce(
      found([aliceEntry(), aliceEntry({ dn: "CN=Alice Other,OU=People,DC=corp,DC=example" })]),
    );

    const err = await expectLdapError(ldapAuthenticate(SETTINGS, "alice", "pw"), "config");

    expect(err.message).toMatch(/matched more than one entry/);
    expect(mocks.client.bind).toHaveBeenCalledTimes(1);
  });

  it("maps a service-account bind failure to config", async () => {
    mocks.client.bind.mockRejectedValueOnce(new InvalidCredentialsError());

    const err = await expectLdapError(ldapAuthenticate(SETTINGS, "alice", "pw"), "config");

    expect(err.message).toBe(
      "The LDAP service account couldn't sign in — check the bind DN and password",
    );
    expect(mocks.client.search).not.toHaveBeenCalled();
    expect(mocks.client.unbind).toHaveBeenCalledTimes(1);
  });

  it("maps a refused connection to connection", async () => {
    mocks.client.bind.mockRejectedValueOnce(connectionRefused());

    const err = await expectLdapError(ldapAuthenticate(SETTINGS, "alice", "pw"), "connection");

    expect(err.message).toBe(
      "Could not reach ldaps://ad.example.com:636: connect ECONNREFUSED 10.0.0.5:636",
    );
  });

  it("points at the CA setting for TLS verification errors", async () => {
    mocks.client.bind.mockRejectedValueOnce(new Error("unable to verify the first certificate"));

    const err = await expectLdapError(ldapAuthenticate(SETTINGS, "alice", "pw"), "connection");

    expect(err.message).toBe(
      "Could not reach ldaps://ad.example.com:636: unable to verify the first certificate — add the directory's CA under Sign-in → LDAP",
    );
  });

  it("maps a timeout to connection", async () => {
    mocks.client.bind.mockRejectedValueOnce(new Error("Connection timeout"));

    const err = await expectLdapError(ldapAuthenticate(SETTINGS, "alice", "pw"), "connection");

    expect(err.message).toMatch(
      /^Could not reach ldaps:\/\/ad\.corp\.example:636: Connection timeout$/,
    );
  });

  it("upgrades a plain connection with STARTTLS before binding", async () => {
    const caPem = "-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----\n";
    mocks.client.search.mockResolvedValueOnce(found([aliceEntry()]));

    await ldapAuthenticate(
      { ...SETTINGS, url: "ldap://ad.example.com:389", startTls: true, caPem, timeoutMs: 2500 },
      "alice",
      "pw",
    );

    expect(constructorOptions()).toEqual({
      url: "ldap://ad.example.com:389",
      timeout: 2500,
      connectTimeout: 2500,
      tlsOptions: { ca: [caPem] },
    });
    expect(mocks.client.startTLS).toHaveBeenCalledTimes(1);
    expect(mocks.client.startTLS).toHaveBeenCalledWith({ ca: [caPem] });
    expect(mocks.client.startTLS.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.client.bind.mock.invocationCallOrder[0]!,
    );
  });

  it("passes insecureSkipVerify through as rejectUnauthorized: false", async () => {
    mocks.client.search.mockResolvedValueOnce(found([aliceEntry()]));

    await ldapAuthenticate({ ...SETTINGS, insecureSkipVerify: true }, "alice", "pw");

    expect(constructorOptions().tlsOptions).toEqual({ rejectUnauthorized: false });
  });

  it("maps a STARTTLS failure to connection", async () => {
    mocks.client.startTLS.mockRejectedValueOnce(
      new Error("self-signed certificate in certificate chain"),
    );

    const err = await expectLdapError(
      ldapAuthenticate(
        { ...SETTINGS, url: "ldap://ad.example.com", startTls: true },
        "alice",
        "pw",
      ),
      "connection",
    );

    expect(err.message).toMatch(/self-signed certificate.*add the directory's CA/);
    expect(mocks.client.bind).not.toHaveBeenCalled();
    expect(mocks.client.unbind).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty password without touching the network", async () => {
    const err = await expectLdapError(
      ldapAuthenticate(SETTINGS, "alice", ""),
      "invalid_credentials",
    );

    expect(err.message).toBe("Wrong username or password");
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.client.bind).not.toHaveBeenCalled();
    expect(mocks.client.search).not.toHaveBeenCalled();
  });

  it("refuses an empty or blank username without touching the network", async () => {
    await expectLdapError(ldapAuthenticate(SETTINGS, "", "pw"), "invalid_credentials");
    await expectLdapError(ldapAuthenticate(SETTINGS, "   ", "pw"), "invalid_credentials");

    expect(mocks.construct).not.toHaveBeenCalled();
  });

  it("rejects a malformed URL as config before connecting", async () => {
    const err = await expectLdapError(
      ldapAuthenticate({ ...SETTINGS, url: "ad.example.com" }, "alice", "pw"),
      "config",
    );

    expect(err.message).toMatch(/ldap:\/\/host:389 or ldaps:\/\/host:636/);
    expect(mocks.construct).not.toHaveBeenCalled();
  });

  it("rejects a broken user filter as config before searching", async () => {
    const unbalanced = await expectLdapError(
      ldapAuthenticate({ ...SETTINGS, userFilter: "(uid={{username}}" }, "alice", "pw"),
      "config",
    );
    expect(unbalanced.message).toMatch(/user filter is invalid/);

    const unknownPlaceholder = await expectLdapError(
      ldapAuthenticate({ ...SETTINGS, userFilter: "(uid={{user}})" }, "alice", "pw"),
      "config",
    );
    expect(unknownPlaceholder.message).toMatch(/Unknown placeholder \{\{user\}\}/);

    expect(mocks.client.search).not.toHaveBeenCalled();
  });

  it("maps a user search failure (e.g. a missing base DN) to config", async () => {
    mocks.client.search.mockRejectedValueOnce(new NoSuchObjectError());

    const err = await expectLdapError(ldapAuthenticate(SETTINGS, "alice", "pw"), "config");

    expect(err.message).toMatch(/^LDAP user search failed: .*check the user base DN and filter$/);
    expect(err.message).not.toMatch(/Code: 0x/);
  });

  it("fails closed when the group search errors", async () => {
    mocks.client.search
      .mockResolvedValueOnce(found([aliceEntry()]))
      .mockRejectedValueOnce(new NoSuchObjectError());

    const err = await expectLdapError(
      ldapAuthenticate({ ...SETTINGS, groupMode: "search" }, "alice", "pw"),
      "config",
    );

    expect(err.message).toMatch(/group search failed/);
  });

  it("falls back from objectGUID to entryUUID, then to the DN", async () => {
    mocks.client.search
      .mockResolvedValueOnce(
        found([aliceEntry({ objectGUID: [], entryUUID: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6" })]),
      )
      .mockResolvedValueOnce(found([aliceEntry({ objectGUID: undefined, entryUUID: [] })]));

    const openLdap = await ldapAuthenticate(SETTINGS, "alice", "pw");
    const bare = await ldapAuthenticate(SETTINGS, "alice", "pw");

    expect(openLdap.externalId).toBe("f81d4fae-7dec-11d0-a765-00a0c91e6bf6");
    expect(bare.externalId).toBe(ALICE_DN);
  });

  it("accepts an objectGUID the server already formatted", async () => {
    mocks.client.search.mockResolvedValueOnce(
      found([aliceEntry({ objectGUID: "04030201-0605-0807-090A-0B0C0D0E0F10" })]),
    );

    const user = await ldapAuthenticate(SETTINGS, "alice", "pw");

    expect(user.externalId).toBe("04030201-0605-0807-090a-0b0c0d0e0f10");
  });

  it("normalises string, array and Buffer attribute values", async () => {
    mocks.client.search.mockResolvedValueOnce(
      found([
        {
          dn: ALICE_DN,
          samaccountname: Buffer.from("alice"),
          mail: ["alice@example.com", "a.smith@example.com"],
          displayName: [],
          cn: "Alice S",
          memberOf: DEVELOPERS_DN,
        },
      ]),
    );

    const user = await ldapAuthenticate(SETTINGS, "ALICE", "pw");

    expect(user.username).toBe("alice");
    expect(user.email).toBe("alice@example.com");
    expect(user.displayName).toBe("Alice S");
    expect(user.groups).toEqual(["Developers"]);
    expect(user.groupDns).toEqual([DEVELOPERS_DN]);
  });

  it("falls back to the typed username and empty email when attributes are missing", async () => {
    mocks.client.search.mockResolvedValueOnce(found([{ dn: ALICE_DN }]));

    const user = await ldapAuthenticate(SETTINGS, "alice", "pw");

    expect(user).toEqual({
      dn: ALICE_DN,
      externalId: ALICE_DN,
      username: "alice",
      email: "",
      displayName: "alice",
      groups: [],
      groupDns: [],
      accountDisabled: false,
    });
  });

  it("honours custom attribute names", async () => {
    mocks.client.search.mockResolvedValueOnce(
      found([{ dn: ALICE_DN, uid: "asmith", email: "as@example.com", fullName: "A. Smith" }]),
    );

    const user = await ldapAuthenticate(
      {
        ...SETTINGS,
        usernameAttribute: "uid",
        emailAttribute: "email",
        displayNameAttribute: "fullName",
      },
      "asmith",
      "pw",
    );

    expect(user.username).toBe("asmith");
    expect(user.email).toBe("as@example.com");
    expect(user.displayName).toBe("A. Smith");
    expect(searchOptions(0).attributes).toEqual(
      expect.arrayContaining(["uid", "email", "fullName", "objectGUID", "entryUUID", "memberOf"]),
    );
    expect(searchOptions(0).attributes).not.toContain("sAMAccountName");
  });

  it("skips the service bind when no bind DN is configured", async () => {
    mocks.client.search.mockResolvedValueOnce(found([aliceEntry()]));

    await ldapAuthenticate({ ...SETTINGS, bindDn: null, bindPassword: null }, "alice", "pw");

    expect(mocks.client.bind.mock.calls).toEqual([[ALICE_DN, "pw"]]);
  });

  it("still unbinds when the search throws", async () => {
    mocks.client.search.mockRejectedValueOnce(
      new Error("Socket error. Message type: SearchRequest (0x63)\nread ECONNRESET"),
    );

    const err = await expectLdapError(ldapAuthenticate(SETTINGS, "alice", "pw"), "connection");

    expect(err.message).toBe(
      "Could not reach ldaps://ad.example.com:636: Socket error. Message type: SearchRequest (0x63) read ECONNRESET",
    );
    expect(mocks.client.unbind).toHaveBeenCalledTimes(1);
  });
});

// ─── ldapTest ───

describe("ldapTest", () => {
  const ROOT_DSE = {
    dn: "",
    vendorName: "OpenLDAP",
    vendorVersion: "2.6.7",
    namingContexts: ["dc=corp,dc=example"],
  };

  function answerSearches(rootDse: unknown, users: unknown[], groups: unknown[] = []) {
    mocks.client.search.mockImplementation(async (base: string) => {
      if (base === "") return found([rootDse]);
      if (base === BASE_DN) return found(users);
      return found(groups);
    });
  }

  it("reports ok with server info and a sample user", async () => {
    answerSearches(ROOT_DSE, [aliceEntry()]);

    const result = await ldapTest(SETTINGS, "alice");

    expect(result).toEqual({
      ok: true,
      boundAs: SVC_DN,
      serverInfo: { vendor: "OpenLDAP 2.6.7", namingContexts: ["dc=corp,dc=example"] },
      sample: {
        dn: ALICE_DN,
        username: "alice",
        email: "alice@example.com",
        displayName: "Alice Smith",
        groups: ["Developers", "Dev, Team"],
      },
    });
    // Never binds as the sample user — there is no password to check.
    expect(mocks.client.bind.mock.calls).toEqual([[SVC_DN, "svc-secret"]]);
    expect(mocks.client.search).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ scope: "base", filter: "(objectClass=*)" }),
    );
    expect(mocks.client.unbind).toHaveBeenCalledTimes(1);
  });

  it("recognises Active Directory from the root DSE", async () => {
    answerSearches(
      {
        dn: "",
        rootDomainNamingContext: "DC=corp,DC=example",
        namingContexts: ["DC=corp,DC=example", "CN=Configuration,DC=corp,DC=example"],
      },
      [],
    );

    const result = await ldapTest(SETTINGS);

    expect(result.ok).toBe(true);
    expect(result.serverInfo).toEqual({
      vendor: "Active Directory",
      namingContexts: ["DC=corp,DC=example", "CN=Configuration,DC=corp,DC=example"],
    });
  });

  it("omits the sample when no username is given", async () => {
    answerSearches(ROOT_DSE, [aliceEntry()]);

    const result = await ldapTest(SETTINGS);

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty("sample");
    // Root DSE only — the user filter never runs.
    expect(mocks.client.search).toHaveBeenCalledTimes(1);
  });

  it("reports sample: null when the sample user isn't found", async () => {
    answerSearches(ROOT_DSE, []);

    const result = await ldapTest(SETTINGS, "nobody");

    expect(result.ok).toBe(true);
    expect(result.sample).toBeNull();
    expect(result.boundAs).toBe(SVC_DN);
  });

  it("reads sample groups with the group search in groupMode search", async () => {
    answerSearches(
      ROOT_DSE,
      [aliceEntry({ memberOf: undefined })],
      [{ dn: DEVELOPERS_DN, cn: "Developers" }],
    );

    const result = await ldapTest(
      { ...SETTINGS, groupMode: "search", groupBaseDn: "OU=Groups,DC=corp,DC=example" },
      "alice",
    );

    expect(result.ok).toBe(true);
    expect(result.sample?.groups).toEqual(["Developers"]);
    expect(mocks.client.search).toHaveBeenCalledTimes(3);
  });

  it("reports a bad service account instead of throwing", async () => {
    mocks.client.bind.mockRejectedValueOnce(new InvalidCredentialsError());

    const result = await ldapTest(SETTINGS, "alice");

    expect(result).toEqual({
      ok: false,
      error: "The LDAP service account couldn't sign in — check the bind DN and password",
    });
    expect(mocks.client.unbind).toHaveBeenCalledTimes(1);
  });

  it("reports a connection failure instead of throwing", async () => {
    mocks.client.bind.mockRejectedValueOnce(connectionRefused());

    const result = await ldapTest(SETTINGS);

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "Could not reach ldaps://ad.example.com:636: connect ECONNREFUSED 10.0.0.5:636",
    );
  });

  it("reports a config problem without connecting", async () => {
    const result = await ldapTest({ ...SETTINGS, url: "nope" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/LDAP URL must look like/);
    expect(mocks.construct).not.toHaveBeenCalled();
  });

  it("reports a broken user filter as a failure", async () => {
    answerSearches(ROOT_DSE, []);

    const result = await ldapTest({ ...SETTINGS, userFilter: "(uid={{username}}" }, "alice");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/user filter is invalid/);
  });

  it("still reports ok when the root DSE can't be read", async () => {
    mocks.client.search.mockImplementation(async (base: string) => {
      if (base === "") throw new NoSuchObjectError();
      return found([aliceEntry()]);
    });

    const result = await ldapTest(SETTINGS, "alice");

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty("serverInfo");
    expect(result.sample?.username).toBe("alice");
  });

  it("reports an anonymous bind when no service account is set", async () => {
    answerSearches(ROOT_DSE, []);

    const result = await ldapTest({ ...SETTINGS, bindDn: "", bindPassword: "" });

    expect(result.ok).toBe(true);
    expect(result.boundAs).toBe("anonymous");
    expect(mocks.client.bind).not.toHaveBeenCalled();
  });
});

// ─── Helpers ───

describe("ldapSearchGroups", () => {
  it("binds the service account and searches groups by name under the group base DN", async () => {
    mocks.client.search.mockResolvedValueOnce(
      found([
        { dn: DEVELOPERS_DN, cn: "Developers" },
        { dn: DEV_TEAM_DN, cn: "Dev, Team" },
        { dn: "CN=developers,OU=Old,DC=corp,DC=example", cn: "developers" },
        { dn: "CN=No Cn,OU=Groups,DC=corp,DC=example" },
      ]),
    );
    const hits = await ldapSearchGroups(
      { ...SETTINGS, groupBaseDn: "OU=Groups,DC=corp,DC=example" },
      "dev",
      20,
    );

    expect(mocks.client.bind).toHaveBeenCalledWith(SVC_DN, "svc-secret");
    expect(mocks.client.search.mock.calls[0]![0]).toBe("OU=Groups,DC=corp,DC=example");
    const opts = searchOptions(0);
    expect(opts.filter).toContain("(objectClass=group)");
    expect(opts.filter).toContain("(cn=*dev*)");
    expect(opts.sizeLimit).toBe(20);
    expect(opts.attributes).toEqual(["cn"]);
    // By name, case-insensitively de-duplicated; a cn-less entry is named from its DN.
    expect(hits.map((h) => h.name)).toEqual(["Dev, Team", "Developers", "No Cn"]);
    expect(mocks.client.unbind).toHaveBeenCalled();
  });

  it("escapes what was typed and defaults to the user base DN", async () => {
    await ldapSearchGroups(SETTINGS, "a*)(cn=x", 50);
    expect(mocks.client.search.mock.calls[0]![0]).toBe(BASE_DN);
    expect(searchOptions(0).filter).toContain("(cn=*a\\2a\\29\\28cn=x*)");
  });

  it("lists every group (capped) when nothing was typed", async () => {
    await ldapSearchGroups(SETTINGS, "  ", 500);
    expect(searchOptions(0).filter).toContain("(cn=*)");
    expect(searchOptions(0).sizeLimit).toBeLessThanOrEqual(500);
  });

  it("asks for more of the name when the directory has more than the cap", async () => {
    mocks.client.search.mockRejectedValueOnce(new SizeLimitExceededError());
    const err = await expectLdapError(ldapSearchGroups(SETTINGS, "e", 10), "config");
    expect(err.message).toMatch(/type more of the name/);
  });

  it("maps an unreachable directory like the other entry points", async () => {
    mocks.client.bind.mockRejectedValueOnce(connectionRefused());
    await expect(ldapSearchGroups(SETTINGS, "dev")).rejects.toBeInstanceOf(LdapAuthError);
  });
});

describe("escapeLdapFilterValue", () => {
  it("escapes the RFC 4515 special characters", () => {
    expect(escapeLdapFilterValue("a*b(c)d\\e\0f")).toBe("a\\2ab\\28c\\29d\\5ce\\00f");
  });

  it("leaves ordinary values alone", () => {
    expect(escapeLdapFilterValue("alice.smith@example.com")).toBe("alice.smith@example.com");
    expect(escapeLdapFilterValue("Zoë Müller")).toBe("Zoë Müller");
    expect(escapeLdapFilterValue("")).toBe("");
  });

  it("escapes a backslash before anything it could introduce", () => {
    expect(escapeLdapFilterValue("\\2a")).toBe("\\5c2a");
  });
});

describe("renderLdapFilter", () => {
  it("fills placeholders with escaped values", () => {
    expect(
      renderLdapFilter("(|(uid={{username}})(member={{dn}}))", {
        username: "a*",
        dn: "CN=Smith\\, Al (x),DC=y",
      }),
    ).toBe("(|(uid=a\\2a)(member=CN=Smith\\5c, Al \\28x\\29,DC=y))");
  });

  it("renders a placeholder every time it appears and tolerates inner whitespace", () => {
    expect(
      renderLdapFilter("(|(uid={{username}})(mail={{ username }}))", { username: "bob" }),
    ).toBe("(|(uid=bob)(mail=bob))");
  });

  it("throws on an unknown placeholder", () => {
    expect(() => renderLdapFilter("(uid={{user}})", { username: "bob" })).toThrow(
      "Unknown placeholder {{user}} in LDAP filter",
    );
  });

  it("leaves templates without placeholders untouched", () => {
    expect(renderLdapFilter("(objectClass=person)", {})).toBe("(objectClass=person)");
  });
});

describe("groupNameFromDn", () => {
  it("returns the value of the first RDN", () => {
    expect(groupNameFromDn("CN=Developers,OU=Groups,DC=x")).toBe("Developers");
    expect(groupNameFromDn("cn=ops,dc=x")).toBe("ops");
  });

  it("unescapes an escaped comma", () => {
    expect(groupNameFromDn("CN=Dev\\, Team,OU=Groups,DC=x")).toBe("Dev, Team");
  });

  it("unescapes hex escapes", () => {
    expect(groupNameFromDn("CN=Dev\\2C Team,OU=Groups,DC=x")).toBe("Dev, Team");
    expect(groupNameFromDn("CN=a\\5Cb,DC=x")).toBe("a\\b");
  });

  it("unescapes other backslash escapes", () => {
    expect(groupNameFromDn("CN=a\\+b\\=c\\\\d,DC=x")).toBe("a+b=c\\d");
  });

  it("stops at a multi-valued RDN separator", () => {
    expect(groupNameFromDn("CN=Dev+OU=Groups,DC=x")).toBe("Dev");
  });

  it("copes with a DN that is just one RDN, or has no type at all", () => {
    expect(groupNameFromDn("CN=Lonely")).toBe("Lonely");
    expect(groupNameFromDn("Developers")).toBe("Developers");
    expect(groupNameFromDn("")).toBe("");
  });
});

// ─── The directory sync's reads (services/directory-sync.ts) ───

describe("isAccountDisabled", () => {
  it("reads ACCOUNTDISABLE (0x2) from Active Directory's userAccountControl", () => {
    expect(isAccountDisabled("512")).toBe(false); // NORMAL_ACCOUNT
    expect(isAccountDisabled("514")).toBe(true); // NORMAL_ACCOUNT | ACCOUNTDISABLE
    expect(isAccountDisabled("66050")).toBe(true); // + DONT_EXPIRE_PASSWORD
    expect(isAccountDisabled("66048")).toBe(false);
  });

  it("is false when the directory has no such attribute, or it isn't a number", () => {
    expect(isAccountDisabled(undefined)).toBe(false);
    expect(isAccountDisabled("")).toBe(false);
    expect(isAccountDisabled("disabled")).toBe(false);
  });
});

describe("objectGuidBytes", () => {
  it("turns the GUID string Optio stores back into Active Directory's bytes", () => {
    // externalIdFor formats bytes 01..10 as 04030201-0605-0807-090a-0b0c0d0e0f10.
    expect(objectGuidBytes(ALICE_GUID)).toEqual(GUID_BYTES);
    expect(objectGuidBytes(ALICE_GUID.toUpperCase())).toEqual(GUID_BYTES);
  });

  it("is null for anything that isn't a GUID", () => {
    expect(objectGuidBytes("uid=alice,dc=corp")).toBeNull();
    expect(objectGuidBytes("0102")).toBeNull();
  });
});

describe("usernameKeys", () => {
  const attrs = (filter?: string) => usernameKeys(filter).map((k) => k.attribute.toLowerCase());

  it("reads the attributes the default filter matches the sign-in name against", () => {
    expect(attrs(undefined)).toEqual(["samaccountname", "uid", "mail"]);
    expect(attrs("(userPrincipalName={{username}})")).toEqual(["userprincipalname"]);
  });

  it("keeps a prefix and suffix, and leaves out negated items", () => {
    expect(
      usernameKeys("(&(objectClass=user)(!(cn={{username}}))(mail={{username}}@example.com))"),
    ).toEqual([
      { attribute: expect.stringMatching(/^mail$/i), prefix: "", suffix: "@example.com" },
    ]);
  });

  it("is empty for a filter it can't read", () => {
    expect(usernameKeys("(uid={{nope}})")).toEqual([]);
  });
});

describe("openLdapDirectory", () => {
  const alice = { externalId: ALICE_GUID, username: "alice" };

  it("finds a person by their objectGUID and checks the user filter, binding only the service account", async () => {
    mocks.client.search
      .mockResolvedValueOnce(found([aliceEntry({ userAccountControl: "514" })]))
      .mockResolvedValueOnce(found([{ dn: ALICE_DN }]));

    const dir = await openLdapDirectory(SETTINGS);
    const entry = await dir.lookup(alice);
    await dir.close();

    expect(entry).toMatchObject({
      dn: ALICE_DN,
      externalId: ALICE_GUID,
      username: "alice",
      groups: ["Developers", "Dev, Team"],
      accountDisabled: true,
      userFilter: "selects",
    });
    // By identity, as bytes, under the user base DN.
    const byGuid = searchOptions(0).filter as EqualityFilter;
    expect(mocks.client.search.mock.calls[0]![0]).toBe(BASE_DN);
    expect(byGuid).toBeInstanceOf(EqualityFilter);
    expect(byGuid.attribute).toBe("objectGUID");
    expect(byGuid.value).toEqual(GUID_BYTES);
    expect(searchOptions(0).attributes).toEqual(expect.arrayContaining(["userAccountControl"]));
    // Then the user filter, as a sign-in runs it, against that one entry.
    expect(mocks.client.search.mock.calls[1]![0]).toBe(ALICE_DN);
    expect(searchOptions(1)).toMatchObject({
      scope: "base",
      filter: "(|(sAMAccountName=alice)(uid=alice)(mail=alice))",
    });
    // One service bind; never a bind as a person.
    expect(mocks.client.bind.mock.calls).toEqual([[SVC_DN, "svc-secret"]]);
    expect(mocks.client.unbind).toHaveBeenCalledTimes(1);
  });

  it("finds an OpenLDAP person by entryUUID, and asks for entryUUID first after that", async () => {
    const carol = {
      dn: "uid=carol,OU=People,DC=corp,DC=example",
      uid: "carol",
      entryUUID: CAROL_UUID,
    };
    const dave = { dn: "uid=dave,OU=People,DC=corp,DC=example", uid: "dave", entryUUID: DAVE_UUID };
    mocks.client.search
      .mockResolvedValueOnce(found([])) // objectGUID: nothing
      .mockResolvedValueOnce(found([carol]))
      .mockResolvedValueOnce(found([{ dn: carol.dn }]))
      .mockResolvedValueOnce(found([dave]))
      .mockResolvedValueOnce(found([{ dn: dave.dn }]));

    const dir = await openLdapDirectory(SETTINGS);
    const c = await dir.lookup({ externalId: CAROL_UUID, username: "carol" });
    const d = await dir.lookup({ externalId: DAVE_UUID, username: "dave" });
    await dir.close();

    expect(c).toMatchObject({ dn: carol.dn, externalId: CAROL_UUID, userFilter: "selects" });
    expect(d).toMatchObject({ dn: dave.dn, externalId: DAVE_UUID, userFilter: "selects" });
    expect((searchOptions(1).filter as EqualityFilter).attribute).toBe("entryUUID");
    expect((searchOptions(3).filter as EqualityFilter).attribute).toBe("entryUUID");
    expect(mocks.client.search).toHaveBeenCalledTimes(5);
  });

  it("answers null when no entry has their identity, nor their name with their identity", async () => {
    mocks.client.search
      .mockResolvedValueOnce(found([])) // objectGUID
      .mockResolvedValueOnce(found([])) // entryUUID
      .mockResolvedValueOnce(found([aliceEntry()])) // "bob" now names alice's entry
      .mockResolvedValueOnce(found([]))
      .mockResolvedValueOnce(found([]))
      .mockResolvedValueOnce(found([]));

    const dir = await openLdapDirectory(SETTINGS);
    expect(await dir.lookup({ externalId: DAVE_UUID, username: "bob" })).toBeNull();
    expect(await dir.lookup({ externalId: CAROL_UUID, username: "carol" })).toBeNull();
    await dir.close();
    expect(searchOptions(2).filter).toBe("(|(sAMAccountName=bob)(uid=bob)(mail=bob))");
  });

  it("takes the entry its username finds when it has their identity (a directory that keeps GUIDs as text)", async () => {
    mocks.client.search
      .mockResolvedValueOnce(found([]))
      .mockResolvedValueOnce(found([]))
      .mockResolvedValueOnce(found([aliceEntry()]));

    const dir = await openLdapDirectory(SETTINGS);
    expect(await dir.lookup(alice)).toMatchObject({ dn: ALICE_DN, userFilter: "selects" });
    await dir.close();
    expect(mocks.client.search).toHaveBeenCalledTimes(3);
  });

  it("rebuilds the sign-in name from the entry when the filter keys on userPrincipalName", async () => {
    mocks.client.search
      .mockResolvedValueOnce(found([aliceEntry({ userPrincipalName: "alice@example.com" })]))
      .mockResolvedValueOnce(found([])) // "alice" isn't a UPN
      .mockResolvedValueOnce(found([{ dn: ALICE_DN }]));

    const dir = await openLdapDirectory({
      ...SETTINGS,
      userFilter: "(userPrincipalName={{username}})",
    });
    const entry = await dir.lookup(alice);
    await dir.close();

    expect(entry?.userFilter).toBe("selects");
    expect((searchOptions(0).attributes as string[]).map((a) => a.toLowerCase())).toContain(
      "userprincipalname",
    );
    expect(searchOptions(1).filter).toBe("(userPrincipalName=alice)");
    expect(searchOptions(2).filter).toBe("(userPrincipalName=alice@example.com)");
  });

  it("says the filter excludes someone it no longer finds by the name rebuilt from their entry", async () => {
    mocks.client.search
      .mockResolvedValueOnce(found([aliceEntry()]))
      .mockResolvedValueOnce(found([]));

    const dir = await openLdapDirectory({
      ...SETTINGS,
      userFilter:
        "(&(sAMAccountName={{username}})(memberOf=CN=Optio,OU=Groups,DC=corp,DC=example))",
    });
    expect((await dir.lookup(alice))?.userFilter).toBe("excludes");
    await dir.close();
  });

  it("says it can't tell when the entry has no value the filter matches the name against", async () => {
    mocks.client.search
      .mockResolvedValueOnce(found([aliceEntry()]))
      .mockResolvedValueOnce(found([]));

    const dir = await openLdapDirectory({ ...SETTINGS, userFilter: "(employeeID={{username}})" });
    expect((await dir.lookup(alice))?.userFilter).toBe("unknown");
    await dir.close();
  });

  it("reads a DN identity with a base search, and never outside the user base DN", async () => {
    mocks.client.search
      .mockResolvedValueOnce(found([aliceEntry({ objectGUID: undefined })]))
      .mockResolvedValueOnce(found([{ dn: ALICE_DN }]))
      .mockRejectedValueOnce(new NoSuchObjectError("No Such Object"));

    const dir = await openLdapDirectory(SETTINGS);
    expect(await dir.lookup({ externalId: ALICE_DN, username: "alice" })).toMatchObject({
      dn: ALICE_DN,
      userFilter: "selects",
    });
    expect(mocks.client.search.mock.calls[0]![0]).toBe(ALICE_DN);
    expect(searchOptions(0).scope).toBe("base");
    // Removed: the base read finds nothing.
    expect(
      await dir.lookup({ externalId: "CN=Bob,OU=People,DC=corp,DC=example", username: null }),
    ).toBeNull();
    // Outside the user base DN: a sign-in wouldn't find them there.
    expect(
      await dir.lookup({ externalId: "CN=Eve,OU=People,DC=other", username: null }),
    ).toBeNull();
    expect(mocks.client.search).toHaveBeenCalledTimes(3);
    await dir.close();
  });

  it("reads groups with a group search in search mode", async () => {
    mocks.client.search
      .mockResolvedValueOnce(found([aliceEntry({ memberOf: undefined })]))
      .mockResolvedValueOnce(found([{ dn: ALICE_DN }]))
      .mockResolvedValueOnce(found([{ dn: DEVELOPERS_DN, cn: "Developers" }]));

    const dir = await openLdapDirectory({
      ...SETTINGS,
      groupMode: "search",
      groupBaseDn: "OU=Groups,DC=corp,DC=example",
    });
    const entry = await dir.lookup(alice);
    await dir.close();

    expect(entry?.groups).toEqual(["Developers"]);
    expect(searchOptions(2).filter).toContain("member=CN=Alice Smith");
  });

  it("throws when the service account can't bind, and closes the connection", async () => {
    mocks.client.bind.mockRejectedValueOnce(new InvalidCredentialsError("bad"));

    const err = await expectLdapError(openLdapDirectory(SETTINGS), "config");
    expect(err.message).toMatch(/service account couldn't sign in/);
    expect(mocks.client.unbind).toHaveBeenCalledTimes(1);
  });

  it("throws for one person when two entries have their identity", async () => {
    mocks.client.search.mockResolvedValueOnce(found([aliceEntry(), aliceEntry({ dn: "CN=x" })]));
    const dir = await openLdapDirectory(SETTINGS);
    await expectLdapError(dir.lookup(alice), "config");
    await dir.close();
  });

  it("throws a connection error when the directory goes away mid-run", async () => {
    mocks.client.search.mockRejectedValueOnce(connectionRefused());
    const dir = await openLdapDirectory(SETTINGS);
    await expectLdapError(dir.lookup(alice), "connection");
    await dir.close();
  });

  it("throws without asking the directory when there's neither an identity nor a username", async () => {
    const dir = await openLdapDirectory(SETTINGS);
    await expect(dir.lookup({ externalId: "opaque", username: "  " })).rejects.toThrow(
      /sign in once/,
    );
    expect(mocks.client.search).not.toHaveBeenCalled();
    await dir.close();
  });
});
