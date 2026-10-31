import { X509Certificate } from "node:crypto";
import type { CacheItem, CacheProvider, Profile, SAML } from "@node-saml/node-saml";
import type { SamlSettings } from "@optio/shared";
import type { OAuthProvider, OAuthTokens, OAuthUser } from "./provider.js";
import { getCallbackUrl, publicApiOrigin } from "./provider.js";
import { oidcFetch } from "./oidc.js";
import { secureIdentityProviderUrl } from "../../utils/idp-url.js";

/**
 * SAML 2.0 single sign-on, SP-initiated (`services/oauth/saml.ts`):
 *
 * - `GET /api/auth/saml/login` sends the browser to the identity provider's
 *   single sign-on URL with an AuthnRequest (HTTP-Redirect binding; its ID is
 *   kept in Redis for 10 minutes so any replica can take the answer) and the
 *   sign-in's state as RelayState.
 * - The identity provider posts the SAMLResponse back to
 *   `POST /api/auth/saml/callback` (the ACS URL). `@node-saml/node-saml`
 *   checks it: the assertion signed with the identity provider's
 *   certificate (the whole response too, with `wantAuthnResponseSigned`),
 *   InResponseTo one of our requests (so an unsolicited or replayed
 *   response is refused), the audience (Optio's entity ID), the issuer when
 *   known, and the validity window (60 s clock skew).
 * - The identity provider is described by its metadata — a URL (re-read
 *   every 24 h; a private CA through `caPem`) or the XML pasted in — or by
 *   hand: single sign-on URL, entity ID and certificate(s). A typed value
 *   wins over the metadata's.
 * - Attributes: the email, name, username and groups are read from the
 *   attributes named in the settings, else from the usual names (`email`,
 *   `mail`, the WS-Federation claim URIs, the LDAP OIDs…). The account's
 *   stable ID is `idAttribute`, else the NameID (a transient NameID falls
 *   back to the email). A group given as an LDAP DN counts by its CN too.
 * - `GET /api/auth/saml/metadata` is Optio's service-provider metadata, for
 *   the identity provider.
 */

export interface SamlIdp {
  entityId: string | null;
  entryPoint: string;
  /** PEM certificates the identity provider signs with. */
  certs: string[];
}

const MD_NS = "urn:oasis:names:tc:SAML:2.0:metadata";
const DS_NS = "http://www.w3.org/2000/09/xmldsig#";
const REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const TRANSIENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient";
const METADATA_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_METADATA_BYTES = 2_000_000;

/** A certificate as PEM, from PEM or the bare base64 a metadata document carries. */
export function toPem(cert: string): string {
  const trimmed = cert.trim();
  if (trimmed.includes("-----BEGIN CERTIFICATE-----")) return trimmed;
  const body = trimmed.replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

/** Every certificate in a PEM bundle (or one bare base64 certificate). */
export function splitCerts(bundle: string): string[] {
  const pems = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (pems) return pems.map((p) => p.trim());
  return bundle.trim() ? [toPem(bundle)] : [];
}

/** The identity provider an IdP metadata document describes. */
export async function parseIdpMetadata(xml: string): Promise<SamlIdp> {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml))
    throw new Error("SAML metadata must not declare document types or entities");
  const { DOMParser } = await import("@xmldom/xmldom");
  const problems: string[] = [];
  const doc = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: (msg: string) => problems.push(msg),
      fatalError: (msg: string) => problems.push(msg),
    },
  }).parseFromString(xml, "text/xml");
  if (problems.length > 0 || !doc?.documentElement) {
    throw new Error(`The metadata isn't valid XML: ${problems[0] ?? "empty document"}`);
  }
  const idp = doc.getElementsByTagNameNS(MD_NS, "IDPSSODescriptor").item(0);
  if (!idp) {
    throw new Error("The metadata has no IDPSSODescriptor — is it the identity provider's?");
  }
  const entity = idp.parentNode as unknown as {
    getAttribute?: (name: string) => string | null;
  } | null;
  const entityId = entity?.getAttribute?.("entityID")?.trim() || null;

  const services = idp.getElementsByTagNameNS(MD_NS, "SingleSignOnService");
  let entryPoint: string | null = null;
  for (let i = 0; i < services.length; i++) {
    const sso = services.item(i)!;
    if (sso.getAttribute("Binding") === REDIRECT_BINDING) {
      entryPoint = sso.getAttribute("Location")?.trim() || null;
      break;
    }
  }
  if (!entryPoint) {
    throw new Error(
      "The metadata has no single sign-on service with the HTTP-Redirect binding, which Optio uses",
    );
  }

  const certs: string[] = [];
  const keys = idp.getElementsByTagNameNS(MD_NS, "KeyDescriptor");
  for (let i = 0; i < keys.length; i++) {
    const key = keys.item(i)!;
    const use = key.getAttribute("use");
    if (use && use !== "signing") continue;
    const x509s = key.getElementsByTagNameNS(DS_NS, "X509Certificate");
    for (let j = 0; j < x509s.length; j++) {
      const text = x509s.item(j)!.textContent?.trim();
      if (text) certs.push(toPem(text));
    }
  }
  if (certs.length === 0) throw new Error("The metadata has no signing certificate");
  return { entityId, entryPoint, certs: [...new Set(certs)] };
}

const metadataCache = new Map<string, { idp: SamlIdp; fetchedAt: number }>();

/** Forget the cached metadata (after the settings change). */
export function resetSamlMetadataCache(): void {
  metadataCache.clear();
}

async function fetchMetadata(settings: SamlSettings, fresh: boolean): Promise<SamlIdp> {
  const url = settings.metadataUrl!.trim();
  const cached = metadataCache.get(url);
  if (!fresh && cached && Date.now() - cached.fetchedAt < METADATA_TTL_MS) return cached.idp;
  try {
    const send = oidcFetch(settings)!;
    const res = await send(url, {
      headers: { Accept: "application/samlmetadata+xml, application/xml, text/xml" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error("Metadata request failed");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("Empty metadata response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_METADATA_BYTES) throw new Error("Metadata exceeds size limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const idp = await parseIdpMetadata(Buffer.concat(chunks).toString("utf8"));
    metadataCache.set(url, { idp, fetchedAt: Date.now() });
    return idp;
  } catch {
    // Network/status/parser details can reveal internal services to the caller.
    throw new Error("Could not read valid identity-provider metadata");
  }
}

/**
 * The identity provider the settings describe: what was typed, over its
 * metadata. Throws, saying what is missing, when it can't be used.
 */
export async function resolveSamlIdp(
  settings: SamlSettings,
  opts: { fresh?: boolean } = {},
): Promise<SamlIdp> {
  let fromMetadata: SamlIdp | null = null;
  if (settings.metadataXml?.trim()) {
    fromMetadata = await parseIdpMetadata(settings.metadataXml);
  } else if (settings.metadataUrl?.trim()) {
    fromMetadata = await fetchMetadata(settings, opts.fresh ?? false);
  }
  const entryPoint = settings.entryPoint?.trim() || fromMetadata?.entryPoint;
  if (!entryPoint) {
    throw new Error(
      "The identity provider's single sign-on URL is unknown: give its metadata or the URL",
    );
  }
  if (!secureIdentityProviderUrl(entryPoint)) {
    throw new Error("The single sign-on URL must start with https://");
  }
  const certs = settings.idpCert?.trim() ? splitCerts(settings.idpCert) : fromMetadata?.certs;
  if (!certs || certs.length === 0) {
    throw new Error(
      "The identity provider's signing certificate is unknown: give its metadata or the certificate",
    );
  }
  for (const pem of certs) {
    try {
      new X509Certificate(pem);
    } catch {
      throw new Error("The identity provider's certificate can't be read: paste it as PEM");
    }
  }
  return {
    entityId: settings.idpEntityId?.trim() || fromMetadata?.entityId || null,
    entryPoint,
    certs,
  };
}

/** What the Test button shows: the identity provider and its certificates (never a key). */
export async function describeSamlIdp(settings: SamlSettings) {
  const idp = await resolveSamlIdp(settings, { fresh: true });
  return {
    entityId: idp.entityId,
    entryPoint: idp.entryPoint,
    certificates: idp.certs.map((pem) => {
      const cert = new X509Certificate(pem);
      return {
        subject: cert.subject,
        notAfter: new Date(cert.validTo).toISOString(),
        fingerprint256: cert.fingerprint256,
      };
    }),
  };
}

/** Optio's entity ID: the audience the identity provider writes into the assertion. */
export function spEntityId(settings: Pick<SamlSettings, "spEntityId">): string {
  return settings.spEntityId?.trim() || `${publicApiOrigin()}/api/auth/saml/metadata`;
}

// ── Attributes → the person ────────────────────────────────────────────────

const DEFAULT_ATTRIBUTES = {
  email: [
    "email",
    "mail",
    "emailaddress",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "http://schemas.xmlsoap.org/claims/EmailAddress",
    "urn:oid:0.9.2342.19200300.100.1.3",
  ],
  name: [
    "displayName",
    "name",
    "http://schemas.microsoft.com/identity/claims/displayname",
    "urn:oid:2.16.840.1.113730.3.1.241",
    "cn",
    "urn:oid:2.5.4.3",
  ],
  givenName: [
    "givenName",
    "firstName",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
    "urn:oid:2.5.4.42",
  ],
  surname: [
    "sn",
    "surname",
    "lastName",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
    "urn:oid:2.5.4.4",
  ],
  username: [
    "username",
    "uid",
    "preferred_username",
    "sAMAccountName",
    "urn:oid:0.9.2342.19200300.100.1.1",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
  ],
  groups: [
    "groups",
    "memberOf",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
    "http://schemas.xmlsoap.org/claims/Group",
    "urn:oid:1.3.6.1.4.1.5923.1.5.1.1",
  ],
};

function valuesOf(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const out: string[] = [];
  for (const v of list) {
    if (typeof v === "string" || typeof v === "number") {
      const s = String(v).trim();
      if (s) out.push(s);
    } else if (v && typeof v === "object" && typeof (v as { _?: unknown })._ === "string") {
      const s = ((v as { _: string })._ as string).trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/** An attribute's values: the configured name, else the first usual name present (any case). */
function attribute(
  attributes: Record<string, unknown>,
  configured: string | null | undefined,
  defaults: string[],
): string[] {
  const names = configured?.trim() ? [configured.trim()] : defaults;
  const lowerKeys = new Map(Object.keys(attributes).map((k) => [k.toLowerCase(), k]));
  for (const name of names) {
    const key = name in attributes ? name : lowerKeys.get(name.toLowerCase());
    if (key === undefined) continue;
    const values = valuesOf(attributes[key]);
    if (values.length > 0) return values;
  }
  return [];
}

/** Whether the assertion carries the attribute (configured, else a default name) at all. */
function hasAttribute(
  attributes: Record<string, unknown>,
  configured: string | null | undefined,
  defaults: string[],
): boolean {
  const names = configured?.trim() ? [configured.trim()] : defaults;
  const keys = new Set(Object.keys(attributes).map((k) => k.toLowerCase()));
  return names.some((name) => keys.has(name.toLowerCase()));
}

/** `CN=Optio Admins,OU=Groups,DC=example,DC=com` → `Optio Admins`. */
function cnOf(value: string): string | null {
  const m = /^\s*cn=((?:\\.|[^,])+)/i.exec(value);
  return m ? m[1]!.replace(/\\(.)/g, "$1").trim() : null;
}

/** The person a validated SAML profile vouches for. */
export function samlProfileToUser(profile: Profile, settings: SamlSettings): OAuthUser {
  const attributes = {
    ...((profile.attributes as Record<string, unknown> | undefined) ?? {}),
  };
  const first = (configured: string | null | undefined, defaults: string[]) =>
    attribute(attributes, configured, defaults)[0];

  let email = first(settings.emailAttribute, DEFAULT_ATTRIBUTES.email) ?? "";
  const nameId = profile.nameID?.trim() ?? "";
  if (!email && !settings.emailAttribute && /^[^@\s]+@[^@\s]+$/.test(nameId)) email = nameId;

  const configuredId = settings.idAttribute?.trim() ? first(settings.idAttribute, []) : undefined;
  if (settings.idAttribute?.trim() && !configuredId) {
    throw new Error("The SAML assertion is missing the configured stable ID attribute");
  }
  if (!email) throw new Error("The SAML assertion carries no email address");
  let externalId = configuredId ?? "";
  if (!externalId) {
    if (nameId && profile.nameIDFormat !== TRANSIENT) externalId = nameId;
    else if (email) externalId = email.toLowerCase();
  }
  if (!externalId) {
    throw new Error(
      "The SAML assertion carries no stable ID (a transient NameID and no email): set the ID attribute",
    );
  }

  const username = first(settings.usernameAttribute, DEFAULT_ATTRIBUTES.username);
  const given = first(null, DEFAULT_ATTRIBUTES.givenName);
  const surname = first(null, DEFAULT_ATTRIBUTES.surname);
  const name =
    first(settings.nameAttribute, DEFAULT_ATTRIBUTES.name) ??
    ([given, surname].filter(Boolean).join(" ") || undefined);

  const groups: string[] = [];
  for (const value of attribute(attributes, settings.groupsAttribute, DEFAULT_ATTRIBUTES.groups)) {
    for (const g of [value, cnOf(value)]) if (g && !groups.includes(g)) groups.push(g);
  }
  // No groups attribute at all is no statement about them.
  const groupsClaimMissing = !hasAttribute(
    attributes,
    settings.groupsAttribute,
    DEFAULT_ATTRIBUTES.groups,
  );

  return {
    externalId,
    email,
    displayName: name || username || email || externalId,
    username,
    // The identity provider signed the assertion that carries the address.
    emailVerified: !!email,
    emailVerifiedByProvider: !!email,
    groups,
    ...(groupsClaimMissing ? { groupsClaimMissing } : {}),
  };
}

// ── The provider ────────────────────────────────────────────────────────────

/**
 * Where the AuthnRequest IDs live between the redirect and the response:
 * Redis, so the replica that takes the response knows the request, and an
 * ID is spent once.
 */
export class RedisRequestCache implements CacheProvider {
  constructor(private readonly ttlMs = REQUEST_TTL_MS) {}

  private async redis() {
    const { getRedisClient } = await import("../event-bus.js");
    return getRedisClient();
  }

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    const redis = await this.redis();
    const ok = await redis.set(`saml_request:${key}`, value, "PX", this.ttlMs, "NX");
    return ok ? { value, createdAt: Date.now() } : null;
  }

  async getAsync(key: string): Promise<string | null> {
    return (await this.redis()).get(`saml_request:${key}`);
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (!key) return null;
    const redis = await this.redis();
    return redis.getdel(`saml_request:${key}`);
  }
}

async function loadSamlSettings(): Promise<SamlSettings | null> {
  const { resolveProviderConfig } = await import("../sign-in-config-service.js");
  const resolved = await resolveProviderConfig("saml");
  return (resolved?.settings as SamlSettings | undefined) ?? null;
}

export class SamlProvider implements OAuthProvider {
  name = "saml";

  constructor(
    private readonly loadSettings: () => Promise<SamlSettings | null> = loadSamlSettings,
    private readonly cache: CacheProvider = new RedisRequestCache(),
  ) {}

  private async settings(): Promise<SamlSettings> {
    const settings = await this.loadSettings();
    if (!settings) throw new Error("SAML sign-in isn't configured");
    return settings;
  }

  /** A node-saml client for these settings and identity provider. */
  private async client(settings: SamlSettings, state: string): Promise<SAML> {
    const idp = await resolveSamlIdp(settings);
    const { SAML: Saml, ValidateInResponseTo } = await import("@node-saml/node-saml");
    const entityId = spEntityId(settings);
    return new Saml({
      callbackUrl: getCallbackUrl("saml"),
      entryPoint: idp.entryPoint,
      issuer: entityId,
      audience: entityId,
      idpCert: idp.certs,
      idpIssuer: idp.entityId ?? undefined,
      identifierFormat: settings.nameIdFormat?.trim() || null,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: settings.wantAuthnResponseSigned ?? false,
      // An AuthnContext of "password" would refuse people who signed in with MFA.
      disableRequestedAuthnContext: true,
      acceptedClockSkewMs: 60_000,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: REQUEST_TTL_MS,
      // Bind the AuthnRequest to its RelayState, including across API replicas.
      cacheProvider: {
        saveAsync: (key, value) => this.cache.saveAsync(`${state}:${key}`, value),
        getAsync: (key) => this.cache.getAsync(`${state}:${key}`),
        removeAsync: (key) => this.cache.removeAsync(key ? `${state}:${key}` : null),
      },
      maxAssertionAgeMs: REQUEST_TTL_MS,
      signatureAlgorithm: "sha256",
    });
  }

  /** The identity provider's URL with the AuthnRequest; `state` travels as RelayState. */
  async authorizeUrl(state: string): Promise<string> {
    const saml = await this.client(await this.settings(), state);
    return saml.getAuthorizeUrlAsync(state, undefined, {});
  }

  exchangeCode(): Promise<OAuthTokens> {
    return Promise.reject(
      new Error("SAML answers with a POST to /api/auth/saml/callback, not a code"),
    );
  }

  fetchUser(): Promise<OAuthUser> {
    return Promise.reject(
      new Error("SAML answers with a POST to /api/auth/saml/callback, not a code"),
    );
  }

  /** Check a posted SAMLResponse and return the person it vouches for. */
  async validateResponse(samlResponse: string, state: string): Promise<OAuthUser> {
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(Buffer.from(samlResponse, "base64").toString("utf8"))) {
      throw new Error("SAML responses must not declare document types or entities");
    }
    const settings = await this.settings();
    const saml = await this.client(settings, state);
    const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
    if (!profile) throw new Error("The SAML response carries no assertion");
    const idp = await resolveSamlIdp(settings);
    if (idp.entityId && profile.issuer !== idp.entityId) {
      throw new Error("The SAML assertion issuer does not match the configured identity provider");
    }
    // Node-SAML 5 checks signatures, audience and time windows. Check the
    // signed bearer confirmation's recipient and request binding as well.
    const { DOMParser } = await import("@xmldom/xmldom");
    const assertion = new DOMParser().parseFromString(profile.getAssertionXml!(), "text/xml");
    const confirmations = assertion.getElementsByTagNameNS(
      "urn:oasis:names:tc:SAML:2.0:assertion",
      "SubjectConfirmationData",
    );
    let bound = false;
    for (let i = 0; i < confirmations.length; i++) {
      const data = confirmations.item(i)!;
      if (
        data.getAttribute("Recipient") === getCallbackUrl("saml") &&
        data.getAttribute("InResponseTo") === profile.inResponseTo &&
        data.getAttribute("NotOnOrAfter")
      )
        bound = true;
    }
    if (!bound)
      throw new Error("The signed SAML subject confirmation must name this callback and request");
    return samlProfileToUser(profile, settings);
  }

  /** Optio's service-provider metadata (null while SAML isn't configured). */
  async metadata(): Promise<string | null> {
    const settings = await this.loadSettings();
    if (!settings) return null;
    const { generateServiceProviderMetadata } = await import("@node-saml/node-saml");
    return generateServiceProviderMetadata({
      issuer: spEntityId(settings),
      callbackUrl: getCallbackUrl("saml"),
      identifierFormat: settings.nameIdFormat?.trim() || null,
      wantAssertionsSigned: true,
    });
  }
}
