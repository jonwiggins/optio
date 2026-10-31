/**
 * An in-memory directory behind ldapts's `Client`, for tests that run the
 * real LDAP code (services/auth/ldap.ts) — sign-in and the directory sync —
 * without a directory server:
 *
 *   const h = vi.hoisted(() => ({ dir: null as FakeDirectory | null }));
 *   vi.mock("ldapts", async (orig) => {
 *     const { fakeLdapClient } = await import("../test-utils/fake-ldap.js");
 *     return { ...(await orig()), Client: fakeLdapClient(() => h.dir!) };
 *   });
 *   import * as ldapts from "ldapts";
 *   h.dir = new FakeDirectory({ serviceDn: SVC, servicePassword: "pw" }, ldapts);
 *   h.dir.addUser("uid=carol,ou=people,dc=corp,dc=test", { uid: "carol", mail: … }, "secret");
 *   h.dir.addToGroup("cn=developers,ou=groups,dc=corp,dc=test", carolDn);
 *
 * Binds check the passwords given here; searches evaluate the real filter
 * (ldapts's FilterParser) over the entries under the base DN, with
 * multi-valued attributes and case-insensitive names and values, as a
 * directory does; a filter object (ldapts's `EqualityFilter` with bytes, as
 * the directory sync's objectGUID lookup sends) is evaluated as it is, and
 * `scope: "base"` reads one entry (no such entry: `NoSuchObjectError`).
 * `memberOf` is kept on the members like OpenLDAP's
 * memberof overlay and Active Directory do. `down = true` makes every call
 * fail like an unreachable server. Only what Optio uses is here.
 *
 * This file imports nothing from ldapts at run time (the mock factory loads
 * it while ldapts itself is being mocked): the classes come in as `lib`.
 */
import type { Filter } from "ldapts";

type Ldapts = Pick<
  typeof import("ldapts"),
  | "AndFilter"
  | "EqualityFilter"
  | "FilterParser"
  | "InvalidCredentialsError"
  | "NoSuchObjectError"
  | "NotFilter"
  | "OrFilter"
  | "PresenceFilter"
  | "SubstringFilter"
>;

/** Attribute values: text, or bytes (Active Directory's objectGUID). */
type Attrs = Record<string, string | string[] | Buffer>;

interface SearchOptions {
  scope?: string;
  filter?: string | Filter;
  attributes?: string[];
  sizeLimit?: number;
}

interface FakeEntry {
  dn: string;
  attrs: Attrs;
}

const lc = (s: string) => s.toLowerCase();

function rawValues(attrs: Attrs, name: string): Array<string | Buffer> {
  const key = Object.keys(attrs).find((k) => lc(k) === lc(name));
  if (!key) return [];
  const v = attrs[key]!;
  return Array.isArray(v) ? v : [v];
}

/** An attribute's text values (bytes left out). */
function values(attrs: Attrs, name: string): string[] {
  return rawValues(attrs, name).filter((v): v is string => typeof v === "string");
}

function matches(lib: Ldapts, filter: Filter, entry: FakeEntry): boolean {
  if (filter instanceof lib.AndFilter) return filter.filters.every((f) => matches(lib, f, entry));
  if (filter instanceof lib.OrFilter) return filter.filters.some((f) => matches(lib, f, entry));
  if (filter instanceof lib.NotFilter) return !matches(lib, filter.filter, entry);
  if (filter instanceof lib.PresenceFilter) {
    return (
      lc(filter.attribute) === "objectclass" || rawValues(entry.attrs, filter.attribute).length > 0
    );
  }
  if (filter instanceof lib.EqualityFilter) {
    const wanted = filter.value;
    if (Buffer.isBuffer(wanted)) {
      return rawValues(entry.attrs, filter.attribute).some(
        (v) => Buffer.isBuffer(v) && v.equals(wanted),
      );
    }
    return values(entry.attrs, filter.attribute).some((v) => lc(v) === lc(wanted));
  }
  if (filter instanceof lib.SubstringFilter) {
    const parts = [filter.initial, ...(filter.any ?? []), filter.final].map((p) =>
      (p ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    const re = new RegExp(`^${parts.join(".*")}$`, "i");
    return values(entry.attrs, filter.attribute).some((v) => re.test(v));
  }
  return false;
}

export class FakeDirectory {
  readonly entries = new Map<string, FakeEntry>();
  private readonly passwords = new Map<string, string>();
  /** Every call fails like an unreachable server. */
  down = false;
  /** Each bind (dn), in order. */
  readonly binds: string[] = [];

  constructor(
    service: { serviceDn: string; servicePassword: string },
    private readonly lib: Ldapts,
  ) {
    this.passwords.set(lc(service.serviceDn), service.servicePassword);
  }

  addUser(dn: string, attrs: Attrs, password?: string): void {
    this.entries.set(lc(dn), { dn, attrs: { objectClass: "inetOrgPerson", ...attrs } });
    if (password !== undefined) this.passwords.set(lc(dn), password);
  }

  addGroup(dn: string, name: string): void {
    if (!this.entries.has(lc(dn))) {
      this.entries.set(lc(dn), {
        dn,
        attrs: { objectClass: "groupOfUniqueNames", cn: name, uniqueMember: [] },
      });
    }
  }

  /** The entry is gone (a leaver removed from the directory). */
  remove(dn: string): void {
    const entry = this.entries.get(lc(dn));
    if (!entry) return;
    for (const g of values(entry.attrs, "memberOf")) this.removeFromGroup(g, dn);
    this.entries.delete(lc(dn));
    this.passwords.delete(lc(dn));
  }

  set(dn: string, attr: string, value: string | string[] | Buffer): void {
    const entry = this.entries.get(lc(dn));
    if (!entry) throw new Error(`no entry ${dn}`);
    entry.attrs[attr] = value;
  }

  addToGroup(groupDn: string, memberDn: string): void {
    this.addGroup(groupDn, groupDn.split(",")[0]!.split("=")[1]!);
    const group = this.entries.get(lc(groupDn))!;
    const members = values(group.attrs, "uniqueMember");
    if (!members.some((m) => lc(m) === lc(memberDn))) {
      group.attrs.uniqueMember = [...members, memberDn];
    }
    const member = this.entries.get(lc(memberDn));
    if (member) {
      const of = values(member.attrs, "memberOf");
      if (!of.some((g) => lc(g) === lc(groupDn))) member.attrs.memberOf = [...of, groupDn];
    }
  }

  removeFromGroup(groupDn: string, memberDn: string): void {
    const group = this.entries.get(lc(groupDn));
    if (group) {
      group.attrs.uniqueMember = values(group.attrs, "uniqueMember").filter(
        (m) => lc(m) !== lc(memberDn),
      );
    }
    const member = this.entries.get(lc(memberDn));
    if (member) {
      member.attrs.memberOf = values(member.attrs, "memberOf").filter((g) => lc(g) !== lc(groupDn));
    }
  }

  // ── What the fake Client calls ──

  check(): void {
    if (this.down) {
      throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:636"), {
        code: "ECONNREFUSED",
      });
    }
  }

  bind(dn: string, password: string): void {
    this.check();
    this.binds.push(dn);
    const expected = this.passwords.get(lc(dn));
    if (expected === undefined || expected !== password || !password) {
      throw new this.lib.InvalidCredentialsError("Invalid Credentials");
    }
  }

  /** Each search's base and scope, in order. */
  readonly searches: Array<{ base: string; scope: string }> = [];

  search(
    base: string,
    opts: SearchOptions,
  ): { searchEntries: Array<Record<string, unknown>>; searchReferences: string[] } {
    this.check();
    const scope = opts.scope ?? "sub";
    this.searches.push({ base, scope });
    const filter =
      typeof opts.filter === "object"
        ? opts.filter
        : this.lib.FilterParser.parseString(opts.filter ?? "(objectClass=*)");
    if (scope === "base" && !this.entries.has(lc(base))) {
      throw new this.lib.NoSuchObjectError("No Such Object");
    }
    const found = [...this.entries.values()]
      .filter((e) => (scope === "base" ? lc(e.dn) === lc(base) : lc(e.dn).endsWith(lc(base))))
      .filter((e) => matches(this.lib, filter, e))
      .slice(0, opts.sizeLimit && opts.sizeLimit > 0 ? opts.sizeLimit : undefined);
    const wanted = opts.attributes?.map(lc);
    return {
      searchEntries: found.map((e) => {
        const out: Record<string, unknown> = { dn: e.dn };
        for (const [k, v] of Object.entries(e.attrs)) {
          if (!wanted || wanted.includes(lc(k))) out[k] = v;
        }
        return out;
      }),
      searchReferences: [],
    };
  }
}

/** A `Client` class answering from the directory `dir()` gives, to put in place of ldapts's with `vi.mock`. */
export function fakeLdapClient(dir: () => FakeDirectory) {
  return class FakeLdapClient {
    constructor(_options: unknown) {}
    async startTLS(): Promise<void> {
      dir().check();
    }
    async bind(dn: string, password: string): Promise<void> {
      dir().bind(dn, password);
    }
    async search(base: string, opts: SearchOptions) {
      return dir().search(base, opts);
    }
    async unbind(): Promise<void> {}
  };
}
