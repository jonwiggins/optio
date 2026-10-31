import type { LdapSignInSettings } from "@optio/shared";
import { ldapSearchGroups } from "./auth/ldap.js";
import { qualifiedGroupParts } from "@optio/shared";
import { qualifyGroups } from "./identity-groups.js";
import { sql } from "drizzle-orm";
import { SIGN_IN_PROVIDERS } from "./sign-in-config-service.js";
import { db } from "../db/client.js";
import { logger } from "../logger.js";
import { resolveProviderConfig } from "./sign-in-config-service.js";

/**
 * The group names the group pickers offer (`GET /api/auth/groups`): which
 * groups open a workspace, make admins, or permit sign-in.
 *
 * The LDAP directory's groups (when LDAP sign-in is set up), seen groups and
 * configured workspace/provider rules, merged by qualified name
 * (case-insensitively).
 */

export interface SignInGroup {
  name: string;
  source: "ldap" | "seen";
}

export interface SignInGroupSearch {
  groups: SignInGroup[];
  /** Why the directory couldn't be searched (the seen groups are still there). */
  ldapError?: string;
}

const MAX_LIMIT = 50;

/** Groups Optio has seen whose name contains `q` (ILIKE), at most `limit`. */
async function seenGroups(q: string, limit: number): Promise<string[]> {
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db.execute<{ name: string }>(sql`
    SELECT name FROM (
      SELECT DISTINCT g AS name FROM users, jsonb_array_elements_text(users.sso_groups) g
      UNION
      SELECT DISTINCT g AS name FROM workspaces, jsonb_array_elements_text(workspaces.access_groups) g
    ) seen
    WHERE name ILIKE ${like}
    ORDER BY name
    LIMIT ${limit}
  `);
  return [...rows].map((r) => r.name).filter(Boolean);
}

/** Search the group pickers' names: the directory's (LDAP) and the ones seen. */
export async function searchSignInGroups(q: string, limit = MAX_LIMIT): Promise<SignInGroupSearch> {
  const needle = q.trim();
  const cap = Math.max(1, Math.min(limit, MAX_LIMIT));
  const out = new Map<string, SignInGroup>();
  const add = (name: string, source: SignInGroup["source"]) => {
    const key = name.trim().toLowerCase();
    if (key && !out.has(key)) out.set(key, { name: name.trim(), source });
  };

  let ldapError: string | undefined;
  const configs = await Promise.all(
    SIGN_IN_PROVIDERS.map((p) => resolveProviderConfig(p).catch(() => null)),
  );
  const ldap = configs[SIGN_IN_PROVIDERS.indexOf("ldap")];
  if (ldap) {
    const s = ldap.settings as LdapSignInSettings;
    try {
      const hits = await ldapSearchGroups(
        {
          url: s.url,
          startTls: s.startTls,
          caPem: s.caPem,
          insecureSkipVerify: s.insecureSkipVerify,
          bindDn: s.bindDn,
          bindPassword: ldap.clientSecret,
          userBaseDn: s.userBaseDn,
          userFilter: s.userFilter,
          usernameAttribute: s.usernameAttribute,
          emailAttribute: s.emailAttribute,
          displayNameAttribute: s.displayNameAttribute,
          groupMode: s.groupMode,
          groupBaseDn: s.groupBaseDn,
          groupFilter: s.groupFilter,
          timeoutMs: 5000,
        },
        needle,
        cap,
      );
      for (const hit of hits)
        for (const group of qualifyGroups("ldap", s, [hit.name])) add(group, "ldap");
    } catch (err) {
      ldapError = err instanceof Error ? err.message : String(err);
      logger.debug({ err }, "LDAP group search failed; answering the groups seen");
    }
  }

  const seen = await seenGroups(needle, cap).catch((err) => {
    logger.warn({ err }, "listing the groups seen failed");
    return [] as string[];
  });
  const configured = configs.flatMap((c, i) =>
    qualifyGroups(SIGN_IN_PROVIDERS[i], c?.settings, [
      ...((c?.settings as { adminGroups?: string[] } | undefined)?.adminGroups ?? []),
      ...((c?.settings as { requiredGroups?: string[] } | undefined)?.requiredGroups ?? []),
    ]),
  );
  const lowerNeedle = needle.toLowerCase();
  for (const name of [...seen.filter((g) => qualifiedGroupParts(g)), ...configured]) {
    if (!lowerNeedle || name.toLowerCase().includes(lowerNeedle)) add(name, "seen");
  }

  const groups = [...out.values()]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .slice(0, cap);
  return ldapError ? { groups, ldapError } : { groups };
}
