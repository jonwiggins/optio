import type { ConnectionOptions as TlsConnectionOptions } from "node:tls";
import { Client, FilterParser, InvalidCredentialsError, ResultCodeError } from "ldapts";
import type { Entry } from "ldapts";
import {
  LDAP_TLS_REQUIRED_MESSAGE,
  insecureIdentityProviderTlsAllowed,
  ldapPlainTransportRefused,
} from "../../utils/idp-url.js";

/**
 * LDAP / Active Directory sign-in for self-hosted deployments — the
 * username + password form on the web UI.
 *
 * One login is one connection: bind as the service account (or anonymously),
 * search for the user, bind *as the user* to check the password, then read
 * the user's attributes and groups. At most two searches per login (the user,
 * and the groups in "search" mode). Nothing here logs — the caller decides
 * what to record, and passwords never leave this module.
 *
 * Failures are `LdapAuthError`s with a `code` the caller can branch on:
 * `invalid_credentials` and `user_not_found` share the user-facing message
 * ("Wrong username or password") so the browser can't tell them apart, while
 * `config` and `connection` describe what an admin should fix.
 */

export interface LdapSettings {
  /** ldap:// or ldaps:// URL, e.g. ldaps://ad.example.com:636 */
  url: string;
  /** Upgrade a plain ldap:// connection with STARTTLS before binding. */
  startTls?: boolean;
  /** PEM bundle of the CA(s) that signed the directory's certificate (optional). */
  caPem?: string | null;
  /** Skip certificate verification (test labs only). */
  insecureSkipVerify?: boolean;
  /** Service account for the search bind; empty = anonymous bind. */
  bindDn?: string | null;
  bindPassword?: string | null;
  /** Where users live, e.g. DC=corp,DC=example or OU=People,DC=... */
  userBaseDn: string;
  /** Filter with {{username}} placeholder, default "(|(sAMAccountName={{username}})(uid={{username}})(mail={{username}}))" */
  userFilter?: string | null;
  /** Attribute names (defaults: username "sAMAccountName" then "uid", email "mail", displayName "displayName" then "cn", groups "memberOf"). */
  usernameAttribute?: string | null;
  emailAttribute?: string | null;
  displayNameAttribute?: string | null;
  /** How to read the user's groups: "memberOf" (attribute on the user, default) or "search". */
  groupMode?: "memberOf" | "search";
  /** For groupMode "search": base DN and filter with {{dn}} / {{username}} placeholders, default "(|(member={{dn}})(uniqueMember={{dn}})(memberUid={{username}}))". */
  groupBaseDn?: string | null;
  groupFilter?: string | null;
  /** Connect / operation timeout in ms (default 10000). */
  timeoutMs?: number;
}

export interface LdapUser {
  /** The entry's DN. */
  dn: string;
  /** Stable identifier: objectGUID (AD, formatted as a GUID string) or entryUUID, else the DN. */
  externalId: string;
  username: string;
  /** "" when the attribute is missing. */
  email: string;
  /** Falls back to username. */
  displayName: string;
  /** Group names: the CN of each group DN (memberOf) or of each matched group entry; de-duplicated, order preserved. */
  groups: string[];
  /** The full group DNs, for admins who want to match on DN. */
  groupDns: string[];
  /**
   * Active Directory says the account is disabled (`userAccountControl` has
   * ACCOUNTDISABLE, 0x2). False when the directory has no such attribute
   * (OpenLDAP and the like): there, a leaver's entry is removed or taken out
   * of the required groups instead. Sign-in refuses such an account even
   * when the directory accepted its bind.
   */
  accountDisabled: boolean;
}

export class LdapAuthError extends Error {
  constructor(
    message: string,
    readonly code:
      "invalid_credentials" | "user_not_found" | "account_disabled" | "connection" | "config",
  ) {
    super(message);
    this.name = "LdapAuthError";
  }
}

const DEFAULT_USER_FILTER = "(|(sAMAccountName={{username}})(uid={{username}})(mail={{username}}))";
const DEFAULT_GROUP_FILTER = "(|(member={{dn}})(uniqueMember={{dn}})(memberUid={{username}}))";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USERNAME_ATTRIBUTES = ["sAMAccountName", "uid"];
const DEFAULT_DISPLAY_NAME_ATTRIBUTES = ["displayName", "cn"];
const DEFAULT_EMAIL_ATTRIBUTE = "mail";
const MEMBER_OF_ATTRIBUTE = "memberOf";
/** Active Directory's account flags; bit 0x2 (ACCOUNTDISABLE) is a disabled account. */
const USER_ACCOUNT_CONTROL_ATTRIBUTE = "userAccountControl";
const ACCOUNTDISABLE = 0x2;
const GROUP_SIZE_LIMIT = 500;
const WRONG_CREDENTIALS = "Wrong username or password";

// ─── Filters and DNs ───

/** Safe LDAP filter escaping per RFC 4515. */
export function escapeLdapFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (ch) => {
    switch (ch) {
      case "\\":
        return "\\5c";
      case "*":
        return "\\2a";
      case "(":
        return "\\28";
      case ")":
        return "\\29";
      default:
        return "\\00";
    }
  });
}

/**
 * Render {{username}} / {{dn}} placeholders with escaped values. An unknown
 * placeholder is an admin typo — throw rather than quietly match nothing.
 */
export function renderLdapFilter(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new Error(`Unknown placeholder {{${name}}} in LDAP filter`);
    }
    return escapeLdapFilterValue(value);
  });
}

/** "CN=Developers,OU=Groups,DC=x" → "Developers" (handles `\,` and `\2C` escapes). */
export function groupNameFromDn(dn: string): string {
  // Walk the first RDN: it ends at the first unescaped "," or "+".
  let rdn = "";
  let i = 0;
  while (i < dn.length) {
    const ch = dn[i];
    if (ch === "\\" && i + 1 < dn.length) {
      const next = dn[i + 1];
      const hex = dn.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        rdn += String.fromCharCode(parseInt(hex, 16));
        i += 3;
      } else {
        rdn += next;
        i += 2;
      }
      continue;
    }
    if (ch === "," || ch === "+") break;
    rdn += ch;
    i += 1;
  }
  const eq = rdn.indexOf("=");
  return (eq === -1 ? rdn : rdn.slice(eq + 1)).trim();
}

/** Turn a filter syntax error into a `config` error before it reaches the wire. */
function compileFilter(
  what: "user" | "group",
  template: string,
  vars: Record<string, string>,
): string {
  let rendered: string;
  try {
    rendered = renderLdapFilter(template, vars);
    FilterParser.parseString(rendered);
  } catch (err) {
    throw new LdapAuthError(
      `The LDAP ${what} filter is invalid: ${err instanceof Error ? err.message : String(err)}`,
      "config",
    );
  }
  return rendered;
}

// ─── Attribute values ───

type EntryValue = Entry[string];

/** Case-insensitive attribute lookup — AD answers in its own casing. */
function rawAttribute(entry: Entry, name: string): EntryValue | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(entry)) {
    if (key.toLowerCase() === wanted) return entry[key];
  }
  return undefined;
}

/** All values of an attribute as non-empty strings (string | string[] | Buffer | Buffer[]). */
function attributeValues(entry: Entry, name: string): string[] {
  const raw = rawAttribute(entry, name);
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of list) {
    const str = Buffer.isBuffer(item) ? item.toString("utf8") : String(item);
    if (str.length > 0) out.push(str);
  }
  return out;
}

/** First non-empty value among the candidate attribute names, in order. */
function firstAttribute(entry: Entry, names: string[]): string | undefined {
  for (const name of names) {
    const [value] = attributeValues(entry, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** AD's objectGUID bytes → "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" (first three parts little-endian). */
function formatObjectGuid(raw: EntryValue): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  if (Buffer.isBuffer(value)) {
    if (value.length === 0) return undefined;
    if (value.length !== 16) return value.toString("hex");
    const hex = (bytes: Buffer) => bytes.toString("hex");
    const le = (bytes: Buffer) => hex(Buffer.from(bytes).reverse());
    return [
      le(value.subarray(0, 4)),
      le(value.subarray(4, 6)),
      le(value.subarray(6, 8)),
      hex(value.subarray(8, 10)),
      hex(value.subarray(10, 16)),
    ].join("-");
  }
  // Some directories hand the GUID back already formatted.
  return /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

function externalIdFor(entry: Entry): string {
  const guidRaw = rawAttribute(entry, "objectGUID");
  const guid = guidRaw === undefined ? undefined : formatObjectGuid(guidRaw);
  if (guid) return guid;
  const [entryUuid] = attributeValues(entry, "entryUUID");
  return entryUuid ?? entry.dn;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

// ─── Settings ───

interface ResolvedSettings {
  url: string;
  secure: boolean;
  startTls: boolean;
  tlsOptions: TlsConnectionOptions | undefined;
  bindDn: string | null;
  bindPassword: string;
  userBaseDn: string;
  userFilter: string;
  usernameAttributes: string[];
  emailAttribute: string;
  displayNameAttributes: string[];
  groupMode: "memberOf" | "search";
  groupBaseDn: string;
  groupFilter: string;
  timeoutMs: number;
}

function trimmed(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/** Fill defaults and reject what can't possibly work — before touching the network. */
function resolveSettings(settings: LdapSettings): ResolvedSettings {
  const url = trimmed(settings.url);
  const scheme = /^(ldaps?):\/\/[^/]+$/i.exec(url)?.[1]?.toLowerCase();
  if (!scheme) {
    throw new LdapAuthError(
      `The LDAP URL must look like ldap://host:389 or ldaps://host:636 (got "${url}")`,
      "config",
    );
  }
  const userBaseDn = trimmed(settings.userBaseDn);
  if (!userBaseDn) {
    throw new LdapAuthError("The LDAP user base DN is required", "config");
  }
  const secure = scheme === "ldaps";
  // Settings stored (or set in the environment) before the deployment
  // required TLS stay refused, before any password is sent.
  if (ldapPlainTransportRefused({ url, startTls: settings.startTls })) {
    throw new LdapAuthError(LDAP_TLS_REQUIRED_MESSAGE, "config");
  }
  const tlsOptions: TlsConnectionOptions = {};
  if (settings.caPem?.trim()) tlsOptions.ca = [settings.caPem];
  if (settings.insecureSkipVerify) {
    // Settings stored before the deployment withdrew its opt-in stay refused.
    if (!insecureIdentityProviderTlsAllowed()) {
      throw new LdapAuthError(
        "Insecure identity-provider TLS is disabled by deployment policy",
        "config",
      );
    }
    tlsOptions.rejectUnauthorized = false;
  }

  const usernameAttribute = trimmed(settings.usernameAttribute);
  const displayNameAttribute = trimmed(settings.displayNameAttribute);
  const bindDn = trimmed(settings.bindDn);
  const timeoutMs =
    settings.timeoutMs && settings.timeoutMs > 0 ? settings.timeoutMs : DEFAULT_TIMEOUT_MS;

  return {
    url,
    secure,
    // STARTTLS on an ldaps:// connection is a no-op: it is already TLS.
    startTls: !!settings.startTls && !secure,
    tlsOptions: Object.keys(tlsOptions).length ? tlsOptions : undefined,
    bindDn: bindDn || null,
    bindPassword: settings.bindPassword ?? "",
    userBaseDn,
    userFilter: trimmed(settings.userFilter) || DEFAULT_USER_FILTER,
    usernameAttributes: usernameAttribute ? [usernameAttribute] : DEFAULT_USERNAME_ATTRIBUTES,
    emailAttribute: trimmed(settings.emailAttribute) || DEFAULT_EMAIL_ATTRIBUTE,
    displayNameAttributes: displayNameAttribute
      ? [displayNameAttribute]
      : DEFAULT_DISPLAY_NAME_ATTRIBUTES,
    groupMode: settings.groupMode === "search" ? "search" : "memberOf",
    groupBaseDn: trimmed(settings.groupBaseDn) || userBaseDn,
    groupFilter: trimmed(settings.groupFilter) || DEFAULT_GROUP_FILTER,
    timeoutMs,
  };
}

// ─── Errors ───

/** ldapts appends " Code: 0x31" to result messages — admins don't need it. */
function reasonOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/\s*Code: 0x[0-9a-f]+$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function connectionError(url: string, err: unknown): LdapAuthError {
  const reason = reasonOf(err);
  const tlsHint = /certificate|altnames|self.signed|ssl|tls/i.test(reason)
    ? " — add the directory's CA under Sign-in → LDAP"
    : "";
  return new LdapAuthError(`Could not reach ${url}: ${reason}${tlsHint}`, "connection");
}

/**
 * Map whatever ldapts threw to an `LdapAuthError`. Directory results are
 * `ResultCodeError`s and mean the config or credentials are wrong; anything
 * else (socket, TLS, timeout) means we couldn't talk to the server.
 */
function mapError(
  err: unknown,
  url: string,
  phase: "serviceBind" | "userSearch" | "userBind" | "groupSearch",
): LdapAuthError {
  if (err instanceof LdapAuthError) return err;
  if (!(err instanceof ResultCodeError)) return connectionError(url, err);
  const reason = reasonOf(err);
  switch (phase) {
    case "serviceBind":
      return new LdapAuthError(
        err instanceof InvalidCredentialsError
          ? "The LDAP service account couldn't sign in — check the bind DN and password"
          : `The LDAP service account couldn't sign in (${reason}) — check the bind DN and password`,
        "config",
      );
    case "userBind":
      if (err instanceof InvalidCredentialsError) {
        return new LdapAuthError(WRONG_CREDENTIALS, "invalid_credentials");
      }
      return new LdapAuthError(`The directory rejected the sign-in: ${reason}`, "config");
    case "userSearch":
      return new LdapAuthError(
        `LDAP user search failed: ${reason} — check the user base DN and filter`,
        "config",
      );
    case "groupSearch":
      return new LdapAuthError(
        `LDAP group search failed: ${reason} — check the group base DN and filter`,
        "config",
      );
  }
}

// ─── Directory session ───

/** One connection; every step maps its own failure. Always `close()` in finally. */
class LdapSession {
  private readonly client: Client;

  constructor(private readonly settings: ResolvedSettings) {
    this.client = new Client({
      url: settings.url,
      timeout: settings.timeoutMs,
      connectTimeout: settings.timeoutMs,
      ...(settings.tlsOptions ? { tlsOptions: settings.tlsOptions } : {}),
    });
  }

  /** STARTTLS (if asked) and bind the service account; anonymous when none is set. */
  async open(): Promise<void> {
    const { settings } = this;
    if (settings.startTls) {
      try {
        await this.client.startTLS(settings.tlsOptions ?? {});
      } catch (err) {
        throw connectionError(settings.url, err);
      }
    }
    await this.bindService();
  }

  async bindService(): Promise<void> {
    const { settings } = this;
    if (!settings.bindDn) return;
    try {
      await this.client.bind(settings.bindDn, settings.bindPassword);
    } catch (err) {
      throw mapError(err, settings.url, "serviceBind");
    }
  }

  /** The attributes a user lookup reads, plus `extra`. */
  userAttributes(extra: string[] = []): string[] {
    const { settings } = this;
    return dedupe([
      ...settings.usernameAttributes,
      settings.emailAttribute,
      ...settings.displayNameAttributes,
      "objectGUID",
      "entryUUID",
      // Active Directory's account flags (ignored by directories without them).
      USER_ACCOUNT_CONTROL_ATTRIBUTE,
      ...(settings.groupMode === "memberOf" ? [MEMBER_OF_ATTRIBUTE] : []),
      ...extra,
    ]);
  }

  /** Find exactly one user entry; two matches is a filter problem, none is `user_not_found`. */
  async findUser(username: string, extraAttributes: string[] = []): Promise<Entry> {
    const { settings } = this;
    const filter = compileFilter("user", settings.userFilter, { username });
    const attributes = this.userAttributes(extraAttributes);
    let entries: Entry[];
    try {
      const result = await this.client.search(settings.userBaseDn, {
        scope: "sub",
        filter,
        attributes,
        explicitBufferAttributes: ["objectGUID"],
        sizeLimit: 2,
      });
      entries = result.searchEntries;
    } catch (err) {
      throw mapError(err, settings.url, "userSearch");
    }
    if (entries.length === 0) {
      throw new LdapAuthError(WRONG_CREDENTIALS, "user_not_found");
    }
    if (entries.length > 1) {
      throw new LdapAuthError(
        `The LDAP user filter matched more than one entry for "${username}" — tighten the user filter`,
        "config",
      );
    }
    return entries[0];
  }

  /** The password check: a simple bind as the user's own DN. */
  async bindUser(dn: string, password: string): Promise<void> {
    try {
      await this.client.bind(dn, password);
    } catch (err) {
      throw mapError(err, this.settings.url, "userBind");
    }
  }

  /** Group entries for groupMode "search" (cn + dn only, capped at 500). */
  async findGroups(userDn: string, username: string): Promise<Entry[]> {
    const { settings } = this;
    const filter = compileFilter("group", settings.groupFilter, { dn: userDn, username });
    try {
      const result = await this.client.search(settings.groupBaseDn, {
        scope: "sub",
        filter,
        attributes: ["cn"],
        sizeLimit: GROUP_SIZE_LIMIT,
      });
      return result.searchEntries;
    } catch (err) {
      throw mapError(err, settings.url, "groupSearch");
    }
  }

  /** Root DSE, best effort — only for the Settings "Test connection" report. */
  async serverInfo(): Promise<{ vendor?: string; namingContexts?: string[] } | undefined> {
    try {
      const result = await this.client.search("", {
        scope: "base",
        filter: "(objectClass=*)",
        attributes: ["vendorName", "vendorVersion", "namingContexts", "rootDomainNamingContext"],
      });
      const root = result.searchEntries[0];
      if (!root) return undefined;
      const vendorName = firstAttribute(root, ["vendorName"]);
      const vendorVersion = firstAttribute(root, ["vendorVersion"]);
      const vendor = vendorName
        ? [vendorName, vendorVersion].filter(Boolean).join(" ")
        : firstAttribute(root, ["rootDomainNamingContext"])
          ? "Active Directory"
          : undefined;
      const namingContexts = attributeValues(root, "namingContexts");
      return {
        ...(vendor ? { vendor } : {}),
        ...(namingContexts.length ? { namingContexts } : {}),
      };
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.unbind();
    } catch {
      // The server may already have dropped us; nothing to clean up.
    }
  }
}

/** Whether AD's `userAccountControl` value has ACCOUNTDISABLE (0x2); false when absent or unreadable. */
export function isAccountDisabled(userAccountControl: string | undefined): boolean {
  if (userAccountControl === undefined) return false;
  const flags = Number.parseInt(userAccountControl.trim(), 10);
  return Number.isFinite(flags) && (flags & ACCOUNTDISABLE) !== 0;
}

/** Shape the user record from the entry (+ group entries in search mode). */
function buildUser(
  settings: ResolvedSettings,
  entry: Entry,
  loginUsername: string,
  groupEntries: Entry[] | null,
): LdapUser {
  const username = firstAttribute(entry, settings.usernameAttributes) ?? loginUsername;
  const email = firstAttribute(entry, [settings.emailAttribute]) ?? "";
  const displayName = firstAttribute(entry, settings.displayNameAttributes) ?? username;

  let groupDns: string[];
  let groups: string[];
  if (groupEntries) {
    const unique = dedupe(groupEntries.map((group) => group.dn));
    const byDn = new Map(groupEntries.map((group) => [group.dn, group]));
    groupDns = unique;
    groups = dedupe(
      unique.map((dn) => firstAttribute(byDn.get(dn)!, ["cn"]) ?? groupNameFromDn(dn)),
    );
  } else {
    groupDns = dedupe(attributeValues(entry, MEMBER_OF_ATTRIBUTE));
    groups = dedupe(groupDns.map(groupNameFromDn));
  }

  return {
    dn: entry.dn,
    externalId: externalIdFor(entry),
    username,
    email,
    displayName,
    groups,
    groupDns,
    accountDisabled: isAccountDisabled(firstAttribute(entry, [USER_ACCOUNT_CONTROL_ATTRIBUTE])),
  };
}

// ─── Public entry points ───

/** Bind as the service account, find the user, bind as the user, read attributes + groups. */
export async function ldapAuthenticate(
  settings: LdapSettings,
  username: string,
  password: string,
): Promise<LdapUser> {
  const login = username.trim();
  // An empty password is an anonymous bind on many servers — never let it through.
  if (!login || password.length === 0) {
    throw new LdapAuthError(WRONG_CREDENTIALS, "invalid_credentials");
  }
  const resolved = resolveSettings(settings);
  const session = new LdapSession(resolved);
  try {
    await session.open();
    const entry = await session.findUser(login);
    await session.bindUser(entry.dn, password);
    // AD refuses a disabled account's bind; a directory that doesn't (a proxy,
    // AD LDS) must not let it in either. Checked after the password, so the
    // answer reveals nothing to someone without it.
    if (isAccountDisabled(firstAttribute(entry, [USER_ACCOUNT_CONTROL_ATTRIBUTE]))) {
      throw new LdapAuthError("This account is disabled in the directory", "account_disabled");
    }
    let groupEntries: Entry[] | null = null;
    if (resolved.groupMode === "search") {
      // Read groups with the service account's rights, not the user's.
      await session.bindService();
      groupEntries = await session.findGroups(entry.dn, login);
    }
    return buildUser(resolved, entry, login, groupEntries);
  } finally {
    await session.close();
  }
}

/**
 * Settings → Sign-in "Test connection": connect, bind the service account, run
 * the user filter with a sample username (optional) and report what was found.
 * Never throws for ordinary failures — returns { ok: false, error } instead.
 */
export async function ldapTest(
  settings: LdapSettings,
  sampleUsername?: string,
): Promise<{
  ok: boolean;
  error?: string;
  boundAs?: string;
  serverInfo?: { vendor?: string; namingContexts?: string[] };
  sample?: Pick<LdapUser, "dn" | "username" | "email" | "displayName" | "groups"> | null;
}> {
  let session: LdapSession | null = null;
  try {
    const resolved = resolveSettings(settings);
    session = new LdapSession(resolved);
    await session.open();
    const boundAs = resolved.bindDn ?? "anonymous";
    const serverInfo = await session.serverInfo();

    const login = sampleUsername?.trim() ?? "";
    if (!login) {
      return { ok: true, boundAs, ...(serverInfo ? { serverInfo } : {}) };
    }

    let entry: Entry;
    try {
      entry = await session.findUser(login);
    } catch (err) {
      if (err instanceof LdapAuthError && err.code === "user_not_found") {
        return { ok: true, boundAs, ...(serverInfo ? { serverInfo } : {}), sample: null };
      }
      throw err;
    }
    const groupEntries =
      resolved.groupMode === "search" ? await session.findGroups(entry.dn, login) : null;
    const user = buildUser(resolved, entry, login, groupEntries);
    return {
      ok: true,
      boundAs,
      ...(serverInfo ? { serverInfo } : {}),
      sample: {
        dn: user.dn,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        groups: user.groups,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await session?.close();
  }
}
