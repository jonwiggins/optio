import type { ConnectionOptions as TlsConnectionOptions } from "node:tls";
import {
  AndFilter,
  Client,
  EqualityFilter,
  FilterParser,
  InvalidCredentialsError,
  NoSuchObjectError,
  OrFilter,
  ResultCodeError,
  SizeLimitExceededError,
} from "ldapts";
import type { Entry, Filter } from "ldapts";

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
   * of the required groups instead. The directory sync reads it
   * (services/directory-sync.ts); AD already refuses such an account's bind.
   */
  accountDisabled: boolean;
}

export class LdapAuthError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_credentials" | "user_not_found" | "connection" | "config",
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
    const ch = dn[i]!;
    if (ch === "\\" && i + 1 < dn.length) {
      const next = dn[i + 1]!;
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
  const tlsOptions: TlsConnectionOptions = {};
  if (settings.caPem?.trim()) tlsOptions.ca = [settings.caPem];
  if (settings.insecureSkipVerify) tlsOptions.rejectUnauthorized = false;

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
    return entries[0]!;
  }

  /** The password check: a simple bind as the user's own DN. */
  async bindUser(dn: string, password: string): Promise<void> {
    try {
      await this.client.bind(dn, password);
    } catch (err) {
      throw mapError(err, this.settings.url, "userBind");
    }
  }

  /**
   * The directory sync's lookup by identity: the one entry under the user
   * base DN whose `attribute` equals `value`, else null. A directory that
   * rejects the attribute (it isn't in its schema) answers null too.
   */
  async findByAttribute(
    attribute: string,
    value: string | Buffer,
    extraAttributes: string[],
  ): Promise<Entry | null> {
    const { settings } = this;
    let entries: Entry[];
    try {
      const result = await this.client.search(settings.userBaseDn, {
        scope: "sub",
        filter: new EqualityFilter({ attribute, value }),
        attributes: this.userAttributes(extraAttributes),
        explicitBufferAttributes: ["objectGUID"],
        sizeLimit: 2,
      });
      entries = result.searchEntries;
    } catch (err) {
      if (err instanceof ResultCodeError) return null;
      throw mapError(err, settings.url, "userSearch");
    }
    if (entries.length > 1) {
      throw new LdapAuthError(
        `Two directory entries have the ${attribute} ${String(value)}`,
        "config",
      );
    }
    return entries[0] ?? null;
  }

  /** The entry at `dn` (a base read), else null; only under the user base DN, where a sign-in looks. */
  async readEntry(dn: string, extraAttributes: string[]): Promise<Entry | null> {
    const { settings } = this;
    if (!dnWithin(dn, settings.userBaseDn)) return null;
    try {
      const result = await this.client.search(dn, {
        scope: "base",
        filter: "(objectClass=*)",
        attributes: this.userAttributes(extraAttributes),
        explicitBufferAttributes: ["objectGUID"],
      });
      return result.searchEntries[0] ?? null;
    } catch (err) {
      if (err instanceof NoSuchObjectError) return null;
      throw mapError(err, settings.url, "userSearch");
    }
  }

  /** Whether the user filter, run with `username` as a sign-in runs it, selects the entry at `dn`. */
  async selects(dn: string, username: string): Promise<boolean> {
    const { settings } = this;
    const filter = compileFilter("user", settings.userFilter, { username });
    try {
      const result = await this.client.search(dn, {
        scope: "base",
        filter,
        attributes: ["1.1"],
      });
      return result.searchEntries.length > 0;
    } catch (err) {
      if (err instanceof NoSuchObjectError) return false;
      throw mapError(err, settings.url, "userSearch");
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

  /**
   * Group entries whose name contains `q` (every group when `q` is empty),
   * for the group pickers: AD's `group`, and the RFC groups other
   * directories use. Under the group base DN (the user base DN when none is
   * set), capped at `limit` — the server answers the first `limit` it finds,
   * so a short `q` on a big directory is a sample, not the whole list.
   */
  async searchGroups(q: string, limit: number): Promise<Entry[]> {
    const { settings } = this;
    const name = q.trim() ? `(cn=*${escapeLdapFilterValue(q.trim())}*)` : "(cn=*)";
    const filter = `(&(|(objectClass=group)(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))${name})`;
    try {
      const result = await this.client.search(settings.groupBaseDn, {
        scope: "sub",
        filter,
        attributes: ["cn"],
        sizeLimit: limit,
      });
      return result.searchEntries;
    } catch (err) {
      // The directory found more than `limit`: ldapts drops what it had, so
      // the only useful answer is "narrow it down".
      if (err instanceof SizeLimitExceededError) {
        throw new LdapAuthError(
          `More than ${limit} groups match — type more of the name`,
          "config",
        );
      }
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

/** What a group search answers: the group's name (its `cn`) and its DN. */
export interface LdapGroupHit {
  name: string;
  dn: string;
}

/**
 * The directory's groups whose name contains `q` — for the group pickers
 * (which workspace a group may join, which team it fills, who is an admin).
 * Binds as the service account, searches under the group base DN (the user
 * base DN when none is set) and answers at most `limit` groups, by name,
 * de-duplicated. Throws an `LdapAuthError` like the other entry points; the
 * caller decides what to show when the directory can't be asked.
 */
export async function ldapSearchGroups(
  settings: LdapSettings,
  q: string,
  limit = 50,
): Promise<LdapGroupHit[]> {
  const resolved = resolveSettings(settings);
  const session = new LdapSession(resolved);
  try {
    await session.open();
    const entries = await session.searchGroups(q, Math.max(1, Math.min(limit, GROUP_SIZE_LIMIT)));
    const seen = new Set<string>();
    const hits: LdapGroupHit[] = [];
    for (const entry of entries) {
      const name = firstAttribute(entry, ["cn"]) ?? groupNameFromDn(entry.dn);
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      hits.push({ name, dn: entry.dn });
    }
    return hits.sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await session.close();
  }
}

// ─── The directory sync's reads (services/directory-sync.ts) ───

const GUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * A GUID string as `externalIdFor` formats AD's objectGUID → the 16 bytes
 * the directory stores (the first three parts little-endian). Null when it
 * isn't a GUID.
 */
export function objectGuidBytes(guid: string): Buffer | null {
  if (!GUID_RE.test(guid)) return null;
  const parts = guid.toLowerCase().split("-");
  const le = (hex: string) => Buffer.from(hex, "hex").reverse();
  return Buffer.concat([
    le(parts[0]!),
    le(parts[1]!),
    le(parts[2]!),
    Buffer.from(parts[3]!, "hex"),
    Buffer.from(parts[4]!, "hex"),
  ]);
}

/** "CN=A, OU=B" and "cn=a,ou=b" compare equal (case and spaces after commas). */
function normalizeDn(dn: string): string {
  return dn
    .trim()
    .toLowerCase()
    .replace(/\s*,\s*/g, ",");
}

/** `dn` is `base` or below it. */
function dnWithin(dn: string, base: string): boolean {
  const d = normalizeDn(dn);
  const b = normalizeDn(base);
  return d === b || d.endsWith("," + b);
}

/** Where the user filter puts the sign-in name: `(attribute=<prefix>{{username}}<suffix>)`. */
export interface UsernameKey {
  attribute: string;
  prefix: string;
  suffix: string;
}

const NAME_MARKER = "optiosigninnamemarker";

/**
 * The equality items of the user filter that hold the sign-in name — outside
 * any `(!…)` — so the sync can rebuild, from a person's own entry, the name a
 * sign-in would find them by: `(userPrincipalName={{username}})` →
 * `userPrincipalName`; the default filter → `sAMAccountName`, `uid`, `mail`.
 */
export function usernameKeys(userFilter: string | null | undefined): UsernameKey[] {
  let root: Filter;
  try {
    root = FilterParser.parseString(
      renderLdapFilter(trimmed(userFilter) || DEFAULT_USER_FILTER, { username: NAME_MARKER }),
    );
  } catch {
    return [];
  }
  const keys: UsernameKey[] = [];
  const walk = (f: Filter) => {
    if (f instanceof AndFilter || f instanceof OrFilter) {
      f.filters.forEach(walk);
      return;
    }
    if (f instanceof EqualityFilter && typeof f.value === "string") {
      const at = f.value.indexOf(NAME_MARKER);
      if (at === -1 || f.value.indexOf(NAME_MARKER, at + 1) !== -1) return;
      keys.push({
        attribute: f.attribute,
        prefix: f.value.slice(0, at),
        suffix: f.value.slice(at + NAME_MARKER.length),
      });
    }
  };
  walk(root);
  return keys;
}

/** The sign-in names `keys` take from an entry's own values (prefix and suffix removed). */
function namesFromEntry(entry: Entry, keys: UsernameKey[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const pre = key.prefix.toLowerCase();
    const suf = key.suffix.toLowerCase();
    for (const value of attributeValues(entry, key.attribute)) {
      const v = value.toLowerCase();
      if (v.length <= pre.length + suf.length || !v.startsWith(pre) || !v.endsWith(suf)) continue;
      out.push(value.slice(pre.length, value.length - suf.length));
    }
  }
  return dedupe(out);
}

/** What the sync knows about a person: the identity and username stored at sign-in. */
export interface DirectoryPerson {
  externalId: string;
  username: string | null;
}

/** A person's entry as the sync reads it. */
export interface DirectoryEntry extends LdapUser {
  /**
   * Whether the LDAP sign-in's user filter still finds this entry — a sign-in
   * finds people only through it: `selects` (with their username, or a name
   * rebuilt from the entry's own values of the attributes the filter matches
   * the sign-in name against); `excludes` (it doesn't with such a name: the
   * filter's other conditions leave them out, so they can't sign in);
   * `unknown` (the entry has no value the filter matches the name against,
   * and their username doesn't find it either).
   */
  userFilter: "selects" | "excludes" | "unknown";
}

/**
 * The directory as the directory sync reads it: one connection bound as the
 * service account, then one lookup per person — by the identity stored at
 * their sign-in, without anyone's password, with the same attributes and
 * group reading as a sign-in. `close()` when done.
 */
export interface LdapDirectory {
  /**
   * The person's entry and groups now; null when no entry has their
   * identity (nor their username, where the directory can't be searched by
   * identity). Throws an `LdapAuthError` for this person alone (two entries
   * with one identity, say), or `connection` when the directory went away.
   */
  lookup(person: DirectoryPerson): Promise<DirectoryEntry | null>;
  close(): Promise<void>;
}

/**
 * Connect and bind the service account (anonymously when none is set).
 * Throws an `LdapAuthError` (`config` / `connection`) when the directory
 * can't be asked at all — the sync then changes nobody.
 *
 * A lookup finds the entry by the identity a sign-in stored — objectGUID
 * (Active Directory) or entryUUID, else the DN — under the user base DN, so
 * a renamed account is still theirs and a re-created one is not. Where that
 * finds nothing it tries their username through the user filter, as the
 * sync did before, and accepts only an entry with their identity (a
 * directory that keeps GUIDs as text, say). Then it checks that the user
 * filter still finds the entry (`DirectoryEntry.userFilter`).
 */
export async function openLdapDirectory(settings: LdapSettings): Promise<LdapDirectory> {
  const resolved = resolveSettings(settings);
  const keys = usernameKeys(resolved.userFilter);
  const keyAttributes = keys.map((k) => k.attribute);
  const session = new LdapSession(resolved);
  try {
    await session.open();
  } catch (err) {
    await session.close();
    throw err;
  }
  // Active Directory answers objectGUID, OpenLDAP entryUUID: try first the
  // one that answered last.
  let guidAttributes = ["objectGUID", "entryUUID"];

  const byIdentity = async (externalId: string): Promise<Entry | null | undefined> => {
    const bytes = objectGuidBytes(externalId);
    if (bytes) {
      for (const attribute of guidAttributes) {
        const value = attribute === "objectGUID" ? bytes : externalId.toLowerCase();
        const entry = await session.findByAttribute(attribute, value, keyAttributes);
        if (entry) {
          if (attribute !== guidAttributes[0]) guidAttributes = [...guidAttributes].reverse();
          return entry;
        }
      }
      return null;
    }
    if (externalId.includes("=")) return session.readEntry(externalId, keyAttributes);
    return undefined; // not an identity Optio can search by
  };

  return {
    async lookup(person: DirectoryPerson): Promise<DirectoryEntry | null> {
      const username = person.username?.trim() ?? "";
      let entry = await byIdentity(person.externalId);
      let foundByName = false;
      if (!entry) {
        if (!username) {
          if (entry === null) return null;
          throw new Error(
            "Optio has no directory identity or username for them; they sign in once",
          );
        }
        try {
          const named = await session.findUser(username, keyAttributes);
          // The name now belongs to someone else: not theirs.
          if (!sameIdentity(person.externalId, named)) return null;
          entry = named;
          foundByName = true;
        } catch (err) {
          if (err instanceof LdapAuthError && err.code === "user_not_found") return null;
          throw err;
        }
      }

      const ownName = firstAttribute(entry, resolved.usernameAttributes);
      let userFilter: DirectoryEntry["userFilter"] = foundByName ? "selects" : "excludes";
      if (!foundByName) {
        const derived = namesFromEntry(entry, keys);
        const names = dedupe([username, ...derived, ownName ?? ""].filter(Boolean));
        let selected = false;
        for (const name of names) {
          if (await session.selects(entry.dn, name)) {
            selected = true;
            break;
          }
        }
        userFilter = selected ? "selects" : derived.length > 0 ? "excludes" : "unknown";
      }

      const groupName = username || ownName || "";
      const groupEntries =
        resolved.groupMode === "search" ? await session.findGroups(entry.dn, groupName) : null;
      return { ...buildUser(resolved, entry, groupName, groupEntries), userFilter };
    },
    close: () => session.close(),
  };
}

/** The entry is the one with the stored identity (its objectGUID / entryUUID, or its DN). */
function sameIdentity(externalId: string, entry: Entry): boolean {
  return (
    externalIdFor(entry).toLowerCase() === externalId.toLowerCase() ||
    normalizeDn(entry.dn) === normalizeDn(externalId)
  );
}
