import { readFileSync } from "node:fs";
import { setOutboundDefaults } from "../../utils/outbound-url.js";
import { samlSettingsSchema } from "../../schemas/sign-in.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheItem, CacheProvider, Profile } from "@node-saml/node-saml";
import { idpCert, idpEntityId, requestId, samlResponse } from "../../test-utils/fake-saml.js";
import {
  SamlProvider,
  RedisRequestCache,
  resetSamlMetadataCache,
  parseIdpMetadata,
  resolveSamlIdp,
  samlProfileToUser,
} from "./saml.js";

const redis = vi.hoisted(() => ({ getdel: vi.fn() }));
vi.mock("../event-bus.js", () => ({ getRedisClient: () => redis }));
let restoreOutbound: (() => void) | undefined;
class MemoryCache implements CacheProvider {
  rows = new Map<string, string>();
  async saveAsync(key: string, value: string): Promise<CacheItem> {
    this.rows.set(key, value);
    return { value, createdAt: Date.now() };
  }
  async getAsync(key: string) {
    return this.rows.get(key) ?? null;
  }
  async removeAsync(key: string | null) {
    const value = key ? (this.rows.get(key) ?? null) : null;
    if (key) this.rows.delete(key);
    return value;
  }
}
const settings = { entryPoint: `${idpEntityId}/sso`, idpEntityId, idpCert };
beforeEach(() => {
  vi.stubEnv("PUBLIC_API_URL", "https://optio.example.test");
});
afterEach(() => {
  restoreOutbound?.();
  restoreOutbound = undefined;
  resetSamlMetadataCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function provider() {
  return new SamlProvider(async () => settings, new MemoryCache());
}

describe("SAML 2.0 sign-in", () => {
  it("stays unavailable until configured", async () => {
    const p = new SamlProvider(async () => null);
    expect(await p.metadata()).toBeNull();
    await expect(p.authorizeUrl("state")).rejects.toThrow("isn't configured");
  });
  it("accepts a fake IdP's signed assertion, maps groups, and refuses replay", async () => {
    const p = provider();
    const url = await p.authorizeUrl("state");
    expect(new URL(url).searchParams.get("RelayState")).toBe("state");
    const response = samlResponse(requestId(url));
    expect(await p.validateResponse(response, "state")).toMatchObject({
      externalId: "person-123",
      email: "alice@example.test",
      displayName: "Alice",
      groups: ["Developers", "CN=Admins,OU=Groups,DC=example,DC=test", "Admins"],
      // The deployment hasn't said the IdP's addresses are authoritative.
      emailVerified: false,
      emailVerifiedByProvider: false,
      directoryEmail: true,
    });
    await expect(p.validateResponse(response, "state")).rejects.toThrow();
  });
  it.each([
    ["unsigned", { signed: false }],
    ["response-only signature", { signed: false, responseSigned: true }],
    ["unsolicited", { unsolicited: true }],
    ["DOCTYPE entity", { doctype: true }],
    ["XSW wrapped", { wrapped: true }],
    [
      "different valid signing key",
      {
        signingKey: readFileSync(
          new URL("../../test-utils/saml/other-key.pem", import.meta.url),
          "utf8",
        ),
        signingCert: readFileSync(
          new URL("../../test-utils/saml/other-cert.pem", import.meta.url),
          "utf8",
        ),
      },
    ],
    ["wrong audience", { audience: "https://other.example.test" }],
    ["wrong issuer", { issuer: "https://other.example.test" }],
    ["wrong recipient", { recipient: "https://other.example.test/callback" }],
    ["expired", { expires: "2000-01-01T00:00:00Z" }],
  ] as const)("rejects %s assertions", async (_label, opts) => {
    const p = provider();
    const id = requestId(await p.authorizeUrl("state"));
    await expect(p.validateResponse(samlResponse(id, opts), "state")).rejects.toThrow();
  });
  it("rejects tampering with an attribute covered by the signature", async () => {
    const p = provider();
    const response = samlResponse(requestId(await p.authorizeUrl("state")));
    const tampered = Buffer.from(
      Buffer.from(response, "base64")
        .toString()
        .replace("alice@example.test", "admin@example.test"),
    ).toString("base64");
    await expect(p.validateResponse(tampered, "state")).rejects.toThrow();
  });
  it("binds a request to its own RelayState", async () => {
    const p = provider();
    const response = samlResponse(requestId(await p.authorizeUrl("first")));
    await p.authorizeUrl("second");
    await expect(p.validateResponse(response, "second")).rejects.toThrow();
    expect((await p.validateResponse(response, "first")).externalId).toBe("person-123");
  });
  it("exports SP metadata with the ACS URL and signed assertion requirement", async () => {
    const xml = await provider().metadata();
    expect(xml).toContain('WantAssertionsSigned="true"');
    expect(xml).toContain('Location="https://optio.example.test/api/auth/saml/callback"');
  });
  it("reads IdP metadata XML and URL, and excludes encryption-only keys", async () => {
    const xml = `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${idpEntityId}"><IDPSSODescriptor><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${idpCert.replace(/-----[^-]+-----|\s/g, "")}</X509Certificate></X509Data></KeyInfo></KeyDescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${idpEntityId}/sso"/></IDPSSODescriptor></EntityDescriptor>`;
    expect(await parseIdpMetadata(xml)).toMatchObject({
      entityId: idpEntityId,
      entryPoint: `${idpEntityId}/sso`,
    });
    restoreOutbound = setOutboundDefaults({
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => new Response(xml),
    });
    expect(
      (await resolveSamlIdp({ metadataUrl: `${idpEntityId}/metadata` }, { fresh: true })).certs,
    ).toHaveLength(1);
  });
  it("maps custom attribute names", () => {
    expect(
      samlProfileToUser(
        {
          issuer: idpEntityId,
          nameID: "123",
          attributes: { address: "bob@example.test", full: "Bob", roles: ["Readers"] },
        } as unknown as Profile,
        { emailAttribute: "address", nameAttribute: "full", groupsAttribute: "roles" },
      ),
    ).toMatchObject({ email: "bob@example.test", displayName: "Bob", groups: ["Readers"] });
  });
});

describe("SAML email trust", () => {
  const profile = {
    issuer: idpEntityId,
    nameID: "person-123",
    attributes: { email: "alice@example.test" },
  } as unknown as Profile;
  it("an IdP's address grants nothing by email unless trustEmail says it's authoritative", () => {
    expect(samlProfileToUser(profile, {})).toMatchObject({
      emailVerified: false,
      emailVerifiedByProvider: false,
      directoryEmail: true,
    });
    expect(samlProfileToUser(profile, { trustEmail: true })).toMatchObject({
      emailVerified: true,
      emailVerifiedByProvider: true,
      directoryEmail: false,
    });
  });
  it("keeps trustEmail through the settings schema", () => {
    const parsed = samlSettingsSchema.parse({ ...settings, trustEmail: true });
    expect(parsed.trustEmail).toBe(true);
  });
});

describe("reviewed SAML boundaries", () => {
  it("requires the configured stable ID even when NameID and email exist", () => {
    expect(() =>
      samlProfileToUser(
        { nameID: "person-123", attributes: { email: "alice@example.test" } } as unknown as Profile,
        { idAttribute: "employeeId" },
      ),
    ).toThrow("configured stable ID");
  });
  it("refuses an email-less identity", () => {
    expect(() => samlProfileToUser({ nameID: "person-123" } as Profile, {})).toThrow(
      "no email address",
    );
  });
  it("atomically removes a cached request", async () => {
    redis.getdel.mockResolvedValueOnce("saved");
    expect(await new RedisRequestCache().removeAsync("state:request")).toBe("saved");
    expect(redis.getdel).toHaveBeenCalledWith("saml_request:state:request");
  });
  it("rejects insecure remote URLs and TLS bypass by default", () => {
    vi.stubEnv("OPTIO_IDP_ALLOW_INSECURE_TLS", "false");
    for (const settings of [
      { metadataUrl: "http://idp.example.test/metadata" },
      { ...settingsForSchema(), entryPoint: "http://idp.example.test/sso" },
      { ...settingsForSchema(), insecureSkipVerify: true },
    ]) {
      expect(samlSettingsSchema.safeParse(settings).success).toBe(false);
    }
  });
  it("blocks private metadata before fetching", async () => {
    const send = vi.fn();
    restoreOutbound = setOutboundDefaults({
      resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
      fetchImpl: send,
    });
    await expect(
      resolveSamlIdp({ metadataUrl: "https://idp.example.test/private" }),
    ).rejects.toThrow("Could not read valid");
    expect(send).not.toHaveBeenCalled();
  });
  it("refuses metadata redirects without following them", async () => {
    const send = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } }),
      );
    restoreOutbound = setOutboundDefaults({
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: send,
    });
    await expect(
      resolveSamlIdp({ metadataUrl: "https://idp.example.test/redirect" }),
    ).rejects.toThrow("Could not read valid");
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
  });
  it("limits metadata while streaming, cancels the body, and hides parse/status details", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1_000_001));
      },
      cancel,
    });
    const send = vi
      .fn()
      .mockResolvedValueOnce(new Response(stream))
      .mockResolvedValueOnce(
        new Response("INTERNAL-DETAIL", { status: 503, statusText: "PRIVATE-SERVICE" }),
      )
      .mockResolvedValueOnce(new Response("INTERNAL-PARSER-DETAIL"));
    restoreOutbound = setOutboundDefaults({
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: send,
    });
    for (let i = 0; i < 3; i++) {
      await expect(
        resolveSamlIdp({ metadataUrl: `https://idp.example.test/large${i}` }),
      ).rejects.toThrow(/^Could not read valid identity-provider metadata$/);
    }
    expect(cancel).toHaveBeenCalledOnce();
  });
});
function settingsForSchema() {
  return { entryPoint: `${idpEntityId}/sso`, idpCert };
}
