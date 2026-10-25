import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheItem, CacheProvider, Profile } from "@node-saml/node-saml";
import { idpCert, idpEntityId, requestId, samlResponse } from "../../test-utils/fake-saml.js";
import { SamlProvider, parseIdpMetadata, resolveSamlIdp, samlProfileToUser } from "./saml.js";

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
      emailVerifiedByProvider: true,
    });
    await expect(p.validateResponse(response, "state")).rejects.toThrow();
  });
  it.each([
    ["unsigned", { signed: false }],
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(xml));
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
