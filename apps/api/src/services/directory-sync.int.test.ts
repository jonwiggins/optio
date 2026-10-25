/**
 * The directory sync (services/directory-sync.ts) and what it does to an
 * account (services/offboarding.ts), against real Postgres and Redis and an
 * in-memory directory behind the real LDAP code (test-utils/fake-ldap.ts):
 * group changes re-applied (admin group, team mapping, name), Active
 * Directory's disabled bit, a removed entry, a lost required group, coming
 * back, sessions / API keys / WebSocket tokens revoked, own automations
 * paused and resumed (a team's and a manual-only one left alone), the
 * admins told and the audit trail, and the safety rules: an unreachable
 * directory, a held run, the last deployment admin, an admin's own
 * "disabled by hand".
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { FakeDirectory } from "../test-utils/fake-ldap.js";

const h = vi.hoisted(() => ({ dir: null as FakeDirectory | null }));
vi.mock("ldapts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ldapts")>();
  const { fakeLdapClient } = await import("../test-utils/fake-ldap.js");
  return { ...actual, Client: fakeLdapClient(() => h.dir!) };
});

import * as ldapts from "ldapts";
import { FakeDirectory as Directory } from "../test-utils/fake-ldap.js";
import { db } from "../db/client.js";
import {
  apiKeys,
  directorySyncRuns,
  optioActions,
  pausedAutomations,
  persistentAgents,
  sessions,
  teamGroupMappings,
  teamMembers,
  teams,
  users,
  workDefinitions,
  workspaceMembers,
  workspaces,
  wsUpgradeTokens,
} from "../db/schema.js";
import {
  insertWorkflow,
  insertWorkflowTrigger,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import { createApiKey, validateApiKey } from "./api-key-service.js";
import { objectGuidBytes, openLdapDirectory, type LdapDirectory } from "./auth/ldap.js";
import { createSession, createWsToken, validateSession } from "./session-service.js";
import { setDeploymentSetting } from "./deployment-settings.js";
import {
  DIRECTORY_SYNC_ENABLED_KEY,
  DIRECTORY_SYNC_INTERVAL_KEY,
  FILTER_UNKNOWN,
  lastDirectorySyncRun,
  runDirectorySync,
  runDirectorySyncIfDue,
} from "./directory-sync.js";
import { disableUser, signInAccountCheck } from "./offboarding.js";
import { removeDeploymentAdmin } from "./sign-in-config-service.js";
import { createMemoryEmailTransport, setEmailTransportForTests } from "./notify/email.js";

const uniq = () => randomBytes(4).toString("hex");
const SVC = "cn=optio-svc,ou=service,dc=corp,dc=test";
const PEOPLE = "ou=people,dc=corp,dc=test";
const group = (name: string) => `cn=${name},ou=groups,dc=corp,dc=test`;
const mail = createMemoryEmailTransport();

let orgId: string;
let teamId: string;
let wsAdmin: typeof users.$inferSelect;
let lead: typeof users.$inferSelect;
let operator: typeof users.$inferSelect;

async function oidcPerson(name: string, deploymentAdmin = false) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: uniq(),
      email: `${name}-${uniq()}@example.test`,
      displayName: name,
      deploymentAdmin,
    })
    .returning();
  return row!;
}

/** A person in the directory and in Optio (as an LDAP sign-in leaves them). */
async function ldapPerson(uid: string, groups: string[]) {
  const name = `${uid}-${uniq()}`;
  const dn = `uid=${name},${PEOPLE}`;
  const entryUUID = randomUUID();
  h.dir!.addUser(
    dn,
    { uid: name, mail: `${name}@example.test`, displayName: name, cn: name, entryUUID },
    "pw-" + name,
  );
  for (const g of groups) h.dir!.addToGroup(group(g), dn);
  const [user] = await db
    .insert(users)
    .values({
      provider: "ldap",
      externalId: entryUUID,
      username: name,
      email: `${name}@example.test`,
      displayName: name,
    })
    .returning();
  return { user: user!, dn, name, entryUUID };
}

/** An Active Directory person: objectGUID bytes, stored as the GUID string a sign-in stores. */
async function adPerson(sam: string, groups: string[]) {
  const name = `${sam}-${uniq()}`;
  const dn = `cn=${name},${PEOPLE}`;
  const guid = randomUUID();
  h.dir!.addUser(
    dn,
    {
      sAMAccountName: name,
      mail: `${name}@example.test`,
      displayName: name,
      cn: name,
      objectGUID: objectGuidBytes(guid)!,
    },
    "pw-" + name,
  );
  for (const g of groups) h.dir!.addToGroup(group(g), dn);
  const [user] = await db
    .insert(users)
    .values({
      provider: "ldap",
      externalId: guid,
      username: name,
      email: `${name}@example.test`,
      displayName: name,
    })
    .returning();
  return { user: user!, dn, name, guid };
}

const fresh = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0]!;
const enabledOf = async (id: string) =>
  (await db.select().from(workDefinitions).where(eq(workDefinitions.id, id)))[0]!.enabled;

beforeAll(async () => {
  h.dir = new Directory({ serviceDn: SVC, servicePassword: "svc-pw" }, ldapts);
  setEmailTransportForTests(mail);
  const org = await insertWorkspace({ name: "Org", organization: true });
  orgId = org.id;
  wsAdmin = await oidcPerson("ws-admin");
  lead = await oidcPerson("lead");
  operator = await oidcPerson("operator", true);
  await db.insert(workspaceMembers).values([
    { workspaceId: orgId, userId: wsAdmin.id, role: "admin" },
    { workspaceId: orgId, userId: lead.id, role: "member" },
    { workspaceId: orgId, userId: operator.id, role: "admin" },
  ]);
  const [team] = await db
    .insert(teams)
    .values({ workspaceId: orgId, name: "Platform", slug: `platform-${uniq()}` })
    .returning();
  teamId = team!.id;
  await db.insert(teamMembers).values({ teamId, userId: lead.id, role: "admin" });
  await db.insert(teamGroupMappings).values({ teamId, groupName: "developers", role: "member" });
});

afterAll(() => setEmailTransportForTests(null));

beforeEach(() => {
  mail.sent.length = 0;
  h.dir!.down = false;
  vi.stubEnv("LDAP_URL", "ldaps://ldap.example.test:636");
  vi.stubEnv("LDAP_BIND_DN", SVC);
  vi.stubEnv("LDAP_BIND_PASSWORD", "svc-pw");
  vi.stubEnv("LDAP_USER_BASE_DN", PEOPLE);
  vi.stubEnv("LDAP_REQUIRED_GROUPS", "optio-users");
  vi.stubEnv("LDAP_ADMIN_GROUPS", "optio-admins");
  // The organization workspace these tests watch is opt-in (off by default).
  vi.stubEnv("LDAP_AUTO_JOIN_ORGANIZATION", "true");
  vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", "");
  vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.test:25");
  vi.stubEnv("OPTIO_SMTP_FROM", "optio@example.test");
  vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
});

const run = (force = false) => runDirectorySync({ trigger: "manual", force });

describe("directory sync: people who stay", () => {
  it("re-applies the admin group, the team mapping and the name, and counts the change", async () => {
    const p = await ldapPerson("dana", ["optio-users", "optio-admins", "developers"]);
    const first = await run();
    expect(first.status).toBe("ok");
    expect((await fresh(p.user.id)).deploymentAdmin).toBe(true);
    const [member] = await db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, orgId), eq(workspaceMembers.userId, p.user.id)));
    expect(member?.role).toBe("admin");
    const [inTeam] = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, p.user.id)));
    expect(inTeam).toMatchObject({ status: "active", source: "sso" });

    // Out of the admin group and the developers group; renamed in the directory.
    h.dir!.removeFromGroup(group("optio-admins"), p.dn);
    h.dir!.removeFromGroup(group("developers"), p.dn);
    h.dir!.set(p.dn, "displayName", "Dana Levi");
    const second = await run();
    expect(second.status).toBe("ok");
    expect(second.details).toContainEqual(
      expect.objectContaining({ userId: p.user.id, outcome: "changed" }),
    );
    const after = await fresh(p.user.id);
    expect(after.deploymentAdmin).toBe(false);
    expect(after.displayName).toBe("Dana Levi");
    expect(after.disabledAt).toBeNull();
    const [role] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, orgId), eq(workspaceMembers.userId, p.user.id)));
    expect(role?.role).toBe("member");
    const teamsNow = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, p.user.id)));
    expect(teamsNow).toHaveLength(0);

    // Nothing changed: counted as checked, not changed.
    const third = await run();
    expect(third.details.find((d) => d.userId === p.user.id)).toBeUndefined();
    expect(third.checked).toBeGreaterThan(0);
  });
});

describe("directory sync: leavers", () => {
  it("disables an account Active Directory marks disabled, and every way in stops working", async () => {
    const p = await ldapPerson("erin", ["optio-users"]);
    await run();
    // As the LDAP sign-in makes it (with the directory username the sync looks up).
    const s = await createSession("ldap", {
      externalId: p.entryUUID,
      email: `${p.name}@example.test`,
      displayName: p.name,
      username: p.name,
    });
    const key = await createApiKey(p.user.id, "CLI");
    await createWsToken(p.user.id);
    expect(await validateSession(s.token)).not.toBeNull();
    expect(await validateApiKey(key.token)).not.toBeNull();

    h.dir!.set(p.dn, "userAccountControl", "514");
    const r = await run();
    expect(r.details).toContainEqual(
      expect.objectContaining({
        userId: p.user.id,
        outcome: "disabled",
        reason: "disabled_in_directory",
      }),
    );
    const after = await fresh(p.user.id);
    expect(after.disabledAt).not.toBeNull();
    expect(after.disabledReason).toBe("disabled_in_directory");
    expect(await validateSession(s.token)).toBeNull();
    expect(await validateApiKey(key.token)).toBeNull();
    expect(await db.select().from(sessions).where(eq(sessions.userId, p.user.id))).toHaveLength(0);
    expect(
      await db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.userId, p.user.id), isNull(apiKeys.revokedAt))),
    ).toHaveLength(0);
    expect(
      await db.select().from(wsUpgradeTokens).where(eq(wsUpgradeTokens.userId, p.user.id)),
    ).toHaveLength(0);

    // No other door: an OIDC sign-in with the same email is refused too.
    expect(
      await signInAccountCheck("oidc", {
        externalId: "kc-" + p.name,
        email: `${p.name}@example.test`,
        emailVerified: true,
      }),
    ).toBe("account_disabled");

    // The next run leaves them as they are.
    const again = await run();
    expect(again.details).toContainEqual(
      expect.objectContaining({ userId: p.user.id, outcome: "still_disabled" }),
    );
  });

  it("disables a removed entry, pauses only their own automations, and tells the admins", async () => {
    const p = await ldapPerson("frank", ["optio-users", "developers"]);
    await run();
    const nightly = await insertWorkflow({
      name: `nightly ${uniq()}`,
      workspaceId: orgId,
      ownerUserId: p.user.id,
      createdBy: p.user.id,
    });
    await insertWorkflowTrigger(nightly.id, { type: "schedule", config: { cron: "0 2 * * *" } });
    const byHand = await insertWorkflow({
      name: `by hand ${uniq()}`,
      workspaceId: orgId,
      ownerUserId: p.user.id,
    });
    await insertWorkflowTrigger(byHand.id, { type: "manual" });
    const teams_ = await insertWorkflow({
      name: `team's ${uniq()}`,
      workspaceId: orgId,
      ownerUserId: p.user.id,
      ownerTeamId: teamId,
    });
    await insertWorkflowTrigger(teams_.id, { type: "schedule", config: { cron: "0 3 * * *" } });
    const [agent] = await db
      .insert(persistentAgents)
      .values({
        workspaceId: orgId,
        slug: `helper-${uniq()}`,
        name: `Helper ${uniq()}`,
        initialPrompt: "hi",
        ownerUserId: p.user.id,
      })
      .returning();

    h.dir!.remove(p.dn);
    const r = await run();
    expect(r.details).toContainEqual(
      expect.objectContaining({ userId: p.user.id, outcome: "disabled", reason: "gone" }),
    );
    expect(await enabledOf(nightly.id)).toBe(false);
    expect(await enabledOf(byHand.id)).toBe(true);
    expect(await enabledOf(teams_.id)).toBe(true);
    const [agentNow] = await db
      .select()
      .from(persistentAgents)
      .where(eq(persistentAgents.id, agent!.id));
    expect(agentNow!.enabled).toBe(false);
    const paused = await db
      .select()
      .from(pausedAutomations)
      .where(eq(pausedAutomations.userId, p.user.id));
    expect(paused.map((x) => x.targetId).sort()).toEqual([nightly.id, agent!.id].sort());
    // The group-mapped team membership went with the directory.
    expect(
      await db
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, p.user.id))),
    ).toHaveLength(0);

    // The workspace's admins get the list; the team's admin hears they left, without it.
    await vi.waitFor(() => expect(mail.sent.length).toBeGreaterThanOrEqual(2));
    const toAdmin = mail.sent.find((m) => m.to[0] === wsAdmin.email);
    expect(toAdmin?.subject).toContain("can no longer use Optio");
    expect(toAdmin?.text).toContain(nightly.name);
    expect(toAdmin?.text).toContain(agent!.name);
    expect(toAdmin?.text).not.toContain(byHand.name);
    // A workspace admin is sent to the workspace's members; the Settings card
    // is a deployment admin's (operator is both).
    expect(toAdmin?.text).toContain("Open in Optio: https://optio.example.test/workspace-settings");
    expect(toAdmin?.text).not.toContain("#directory-sync");
    await vi.waitFor(() =>
      expect(mail.sent.find((m) => m.to[0] === operator.email)?.text).toContain(
        "Open in Optio: https://optio.example.test/settings#directory-sync",
      ),
    );
    const toLead = mail.sent.find((m) => m.to[0] === lead.email);
    expect(toLead?.text).toContain("Platform");
    expect(toLead?.text).not.toContain(nightly.name);
    expect(mail.sent.some((m) => m.to[0] === `${p.name}@example.test`)).toBe(false);

    // The audit trail: the workspace's entry, and the run's deployment-wide one.
    await vi.waitFor(async () => {
      const entries = await db
        .select()
        .from(optioActions)
        .where(
          and(
            eq(optioActions.action, "user.disabled"),
            sql`${optioActions.params}->>'targetUserId' = ${p.user.id}`,
          ),
        );
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ workspaceId: orgId, userId: null });
      expect(entries[0]!.params).toMatchObject({ reason: "gone", via: "directory", count: 2 });
    });
    const syncs = await db
      .select()
      .from(optioActions)
      .where(eq(optioActions.action, "directory.sync"));
    expect(syncs.length).toBeGreaterThan(0);
    expect(syncs.every((e) => e.workspaceId === null)).toBe(true);
  });

  it("disables someone out of every required group, and enables them when they're back", async () => {
    const p = await ldapPerson("gail", ["optio-users"]);
    await run();
    const job = await insertWorkflow({
      name: `report ${uniq()}`,
      workspaceId: orgId,
      ownerUserId: p.user.id,
    });
    await insertWorkflowTrigger(job.id, { type: "schedule", config: { cron: "0 6 * * 1" } });

    h.dir!.removeFromGroup(group("optio-users"), p.dn);
    await run();
    expect((await fresh(p.user.id)).disabledReason).toBe("not_in_required_group");
    expect(await enabledOf(job.id)).toBe(false);

    h.dir!.addToGroup(group("optio-users"), p.dn);
    const back = await run();
    expect(back.enabled).toBeGreaterThanOrEqual(1);
    expect(back.details).toContainEqual(
      expect.objectContaining({ userId: p.user.id, outcome: "enabled" }),
    );
    expect((await fresh(p.user.id)).disabledAt).toBeNull();
    expect(await enabledOf(job.id)).toBe(true);
    const [row] = await db
      .select()
      .from(pausedAutomations)
      .where(eq(pausedAutomations.targetId, job.id));
    expect(row!.resumedAt).not.toBeNull();
    await vi.waitFor(async () => {
      const entries = await db
        .select()
        .from(optioActions)
        .where(
          and(
            eq(optioActions.action, "user.enabled"),
            sql`${optioActions.params}->>'targetUserId' = ${p.user.id}`,
          ),
        );
      expect(entries.length).toBeGreaterThan(0);
    });
  });

  it("never enables an account an admin disabled by hand", async () => {
    const p = await ldapPerson("hank", ["optio-users"]);
    await run();
    await disableUser(p.user.id, { reason: "admin", byUserId: operator.id });
    const r = await run();
    expect(r.details.find((d) => d.userId === p.user.id)).toBeUndefined();
    expect((await fresh(p.user.id)).disabledReason).toBe("admin");
    // Not even when they sign in through the directory.
    expect(
      await signInAccountCheck("ldap", {
        externalId: p.entryUUID,
        email: `${p.name}@example.test`,
        emailVerified: true,
      }),
    ).toBe("account_disabled");
  });

  it("an LDAP sign-in enables someone the sync disabled once the directory lets them in", async () => {
    const p = await ldapPerson("ida", ["optio-users"]);
    await run();
    h.dir!.removeFromGroup(group("optio-users"), p.dn);
    await run();
    expect((await fresh(p.user.id)).disabledAt).not.toBeNull();
    // An OIDC sign-in doesn't speak for the directory.
    expect(
      await signInAccountCheck("oidc", {
        externalId: "kc-" + p.name,
        email: `${p.name}@example.test`,
        emailVerified: true,
      }),
    ).toBe("account_disabled");
    h.dir!.addToGroup(group("optio-users"), p.dn);
    expect(
      await signInAccountCheck("ldap", {
        externalId: p.entryUUID,
        email: `${p.name}@example.test`,
        emailVerified: true,
      }),
    ).toBe("allowed");
    expect((await fresh(p.user.id)).disabledAt).toBeNull();
  });
});

describe("directory sync: finding people", () => {
  it("finds an Active Directory person by objectGUID", async () => {
    const p = await adPerson("ad-kim", ["optio-users"]);
    const first = await run();
    expect(first.details.find((d) => d.userId === p.user.id)?.outcome).not.toBe("disabled");
    expect((await fresh(p.user.id)).disabledAt).toBeNull();
    h.dir!.removeFromGroup(group("optio-users"), p.dn);
    await run();
    expect((await fresh(p.user.id)).disabledReason).toBe("not_in_required_group");
  });

  it("follows an entry renamed in the directory: the same identity, a new username", async () => {
    const p = await ldapPerson("ren", ["optio-users"]);
    await run();
    const renamed = `${p.name}-new`;
    h.dir!.set(p.dn, "uid", renamed);
    const r = await run();
    expect(r.details.find((d) => d.userId === p.user.id)?.outcome).toBe("changed");
    const after = await fresh(p.user.id);
    expect(after.disabledAt).toBeNull();
    expect(after.username).toBe(renamed);
  });

  it("finds people when the user filter keys on an attribute that isn't their username", async () => {
    vi.stubEnv("LDAP_USER_FILTER", "(userPrincipalName={{username}})");
    const p = await ldapPerson("upn", ["optio-users"]);
    h.dir!.set(p.dn, "userPrincipalName", `${p.name}@example.test`);
    // Their stored username (uid) doesn't round-trip through this filter;
    // the entry's own userPrincipalName does.
    const r = await run();
    expect(r.status).toBe("ok");
    expect(r.details.find((d) => d.userId === p.user.id)?.outcome).toBe("changed");
    expect((await fresh(p.user.id)).disabledAt).toBeNull();
    // Everyone else in this directory has no userPrincipalName: they can't
    // be judged against the filter, so they're left as they are.
    const others = r.details.filter((d) => d.userId !== p.user.id);
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((d) => d.outcome === "error" || d.outcome === "still_disabled")).toBe(true);
    expect(others.find((d) => d.outcome === "error")?.reason).toBe(FILTER_UNKNOWN);
    expect(r.disabled).toBe(0);
  });

  it("disables someone the user filter now leaves out", async () => {
    vi.stubEnv("LDAP_USER_FILTER", "(&(uid={{username}})(!(employeeType=ended)))");
    const p = await ldapPerson("tess", ["optio-users"]);
    await run();
    expect((await fresh(p.user.id)).disabledAt).toBeNull();
    h.dir!.set(p.dn, "employeeType", "ended");
    const r = await run();
    expect(r.details).toContainEqual(
      expect.objectContaining({ userId: p.user.id, outcome: "disabled", reason: "gone" }),
    );
  });

  it("a re-created entry with the leaver's email doesn't get their account back at sign-in", async () => {
    const p = await ldapPerson("rhea", ["optio-users"]);
    await run();
    h.dir!.remove(p.dn);
    await run();
    expect((await fresh(p.user.id)).disabledReason).toBe("gone");
    // A new entry (new entryUUID) with the same email signs in.
    const newcomer = randomUUID();
    h.dir!.addUser(`uid=${p.name}-2,${PEOPLE}`, {
      uid: `${p.name}-2`,
      mail: `${p.name}@example.test`,
      entryUUID: newcomer,
    });
    h.dir!.addToGroup(group("optio-users"), `uid=${p.name}-2,${PEOPLE}`);
    expect(
      await signInAccountCheck("ldap", {
        externalId: newcomer,
        email: `${p.name}@example.test`,
        emailVerified: true,
      }),
    ).toBe("account_disabled");
    expect((await fresh(p.user.id)).disabledReason).toBe("gone");
    // The sync doesn't take it for theirs either.
    const r = await run();
    expect(r.details).toContainEqual(
      expect.objectContaining({ userId: p.user.id, outcome: "still_disabled" }),
    );
  });
});

describe("directory sync: workspaces by group", () => {
  it("takes someone out of a workspace their group no longer opens, not one they were added to by hand", async () => {
    const byGroup = await insertWorkspace({ name: `Payments ${uniq()}` });
    const byHand = await insertWorkspace({ name: `Ledger ${uniq()}` });
    const manual = await insertWorkspace({ name: `Archive ${uniq()}` });
    await db
      .update(workspaces)
      .set({ accessGroups: ["payments"] })
      .where(sql`${workspaces.id} IN (${byGroup.id}, ${byHand.id})`);
    const p = await ldapPerson("pia", ["optio-users", "payments"]);
    await db.insert(workspaceMembers).values({ workspaceId: byHand.id, userId: p.user.id });
    await run();
    const memberOf = async () =>
      (
        await db
          .select({ id: workspaceMembers.workspaceId, via: workspaceMembers.joinedViaGroups })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.userId, p.user.id))
      ).sort((a, b) => a.id.localeCompare(b.id));
    expect(await memberOf()).toEqual(
      expect.arrayContaining([
        { id: byGroup.id, via: true },
        { id: byHand.id, via: null },
      ]),
    );
    // A workspace whose groups an admin removed keeps the people they put in.
    await db.insert(workspaceMembers).values({
      workspaceId: manual.id,
      userId: p.user.id,
      joinedViaGroups: true,
    });

    h.dir!.removeFromGroup(group("payments"), p.dn);
    const r = await run();
    expect(r.details).toContainEqual(
      expect.objectContaining({ userId: p.user.id, outcome: "changed" }),
    );
    const ids = (await memberOf()).map((m) => m.id);
    expect(ids).not.toContain(byGroup.id);
    expect(ids).toEqual(expect.arrayContaining([byHand.id, manual.id, orgId]));
    expect((await fresh(p.user.id)).disabledAt).toBeNull();

    // Back in the group: back in the workspace.
    h.dir!.addToGroup(group("payments"), p.dn);
    await run();
    expect((await memberOf()).map((m) => m.id)).toContain(byGroup.id);
  });
});

describe("directory sync: safety", () => {
  it("changes nobody when the directory can't be reached", async () => {
    const p = await ldapPerson("jo", ["optio-users"]);
    await run();
    h.dir!.remove(p.dn);
    h.dir!.down = true;
    const r = await run();
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/Could not reach/);
    expect((await fresh(p.user.id)).disabledAt).toBeNull();
    // The deployment admins hear it stopped — once, not at every failed run.
    const stopped = () =>
      mail.sent.filter(
        (m) => m.to[0] === operator.email && /can't read the directory/.test(m.subject),
      );
    await vi.waitFor(() => expect(stopped()).toHaveLength(1));
    expect(stopped()[0]!.text).toContain("Could not reach");
    expect((await run()).status).toBe("failed");
    expect(stopped()).toHaveLength(1);
    h.dir!.down = false;
    // Put them back for the runs after this one.
    h.dir!.addUser(p.dn, { uid: p.name, mail: `${p.name}@example.test`, entryUUID: p.entryUUID });
    h.dir!.addToGroup(group("optio-users"), p.dn);
  });

  it("holds a run that would disable too many, until an admin says go ahead", async () => {
    const five = await Promise.all(
      ["k1", "k2", "k3", "k4", "k5"].map((u) => ldapPerson(u, ["optio-users"])),
    );
    await run();
    for (const p of five) h.dir!.remove(p.dn);
    const held = await run();
    expect(held.status).toBe("held");
    expect(held.error).toMatch(/would disable 5 of the/);
    expect(held.details.filter((d) => d.outcome === "would_disable")).toHaveLength(5);
    for (const p of five) expect((await fresh(p.user.id)).disabledAt).toBeNull();
    const holding = () =>
      mail.sent.filter((m) => m.to[0] === operator.email && /is holding/.test(m.subject));
    await vi.waitFor(() => expect(holding()).toHaveLength(1));
    expect(holding()[0]!.text).toContain("Disable them anyway");
    expect((await run()).status).toBe("held");
    expect(holding()).toHaveLength(1);

    const forced = await run(true);
    expect(forced.status).toBe("ok");
    expect(forced.disabled).toBe(5);
    for (const p of five) expect((await fresh(p.user.id)).disabledReason).toBe("gone");
  });

  it("never disables the last enabled deployment admin", async () => {
    const p = await ldapPerson("last", ["optio-users"]);
    await run();
    // Make them the only deployment admin for this test.
    const others = await db
      .update(users)
      .set({ deploymentAdmin: false })
      .where(and(eq(users.deploymentAdmin, true), sql`${users.id} <> ${p.user.id}`))
      .returning({ id: users.id });
    await db.update(users).set({ deploymentAdmin: true }).where(eq(users.id, p.user.id));
    try {
      h.dir!.remove(p.dn);
      const r = await run();
      expect(r.details).toContainEqual(
        expect.objectContaining({ userId: p.user.id, outcome: "kept_last_admin" }),
      );
      expect((await fresh(p.user.id)).disabledAt).toBeNull();
    } finally {
      if (others.length) {
        await db
          .update(users)
          .set({ deploymentAdmin: true })
          .where(
            sql`${users.id} IN (${sql.join(
              others.map((o) => sql`${o.id}`),
              sql`, `,
            )})`,
          );
      }
      await db.update(users).set({ deploymentAdmin: false }).where(eq(users.id, p.user.id));
    }
    // With another admin back, the next run disables them.
    const next = await run();
    expect(next.details).toContainEqual(
      expect.objectContaining({ userId: p.user.id, outcome: "disabled" }),
    );
  });

  it("counts a person whose lookup fails as an error and leaves them alone", async () => {
    const p = await ldapPerson("twin", ["optio-users"]);
    await run();
    // A second entry with the same identity: the directory is broken for them.
    const copy = `uid=twin-copy-${uniq()},${PEOPLE}`;
    h.dir!.addUser(copy, { uid: `${p.name}-copy`, mail: "x@example.test", entryUUID: p.entryUUID });
    try {
      const r = await run();
      expect(r.details).toContainEqual(
        expect.objectContaining({ userId: p.user.id, outcome: "error" }),
      );
      expect((await fresh(p.user.id)).disabledAt).toBeNull();
    } finally {
      h.dir!.remove(copy);
    }
  });

  it("runs one at a time within one API instance too: a second run answers 409", async () => {
    await ldapPerson("solo", ["optio-users"]);
    const runIds = async () =>
      (await db.select({ id: directorySyncRuns.id }).from(directorySyncRuns)).map((r) => r.id);
    const before = new Set(await runIds());
    const real = await openLdapDirectory({
      url: "ldaps://ldap.example.test:636",
      bindDn: SVC,
      bindPassword: "svc-pw",
      userBaseDn: PEOPLE,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const slow: LdapDirectory = {
      async lookup(person) {
        entered();
        await gate;
        return real.lookup(person);
      },
      close: async () => {},
    };
    try {
      const first = runDirectorySync({ trigger: "manual", directory: slow });
      await inside;
      // The scheduled tick on the same instance while the first one runs.
      await expect(runDirectorySync({ trigger: "schedule" })).rejects.toMatchObject({
        status: 409,
      });
      release();
      const done = await first;
      expect(done.status).toBe("ok");
      // One run row: the second call made none, and didn't mark the first failed.
      expect((await runIds()).filter((id) => !before.has(id))).toEqual([done.id]);
      expect((await lastDirectorySyncRun())?.id).toBe(done.id);
      // The lease is free again for the next run.
      expect((await run()).status).toBe("ok");
    } finally {
      release();
      await real.close();
    }
  });

  it("never demotes the last enabled deployment admin, though a disabled one is still flagged", async () => {
    const p = await ldapPerson("lena", ["optio-users", "optio-admins"]);
    await run();
    expect((await fresh(p.user.id)).deploymentAdmin).toBe(true);
    const others = await db
      .update(users)
      .set({ deploymentAdmin: false })
      .where(and(eq(users.deploymentAdmin, true), ne(users.id, p.user.id)))
      .returning({ id: users.id });
    const ghost = await oidcPerson("ghost-admin", true);
    await disableUser(ghost.id, { reason: "admin" });
    try {
      h.dir!.removeFromGroup(group("optio-admins"), p.dn);
      await run();
      expect((await fresh(p.user.id)).deploymentAdmin).toBe(true);
      // Nor removed by hand on the Sign-in card.
      await expect(removeDeploymentAdmin(p.user.id, p.user.id)).rejects.toThrow(
        /last deployment admin/,
      );
      // The disabled admin's role can be removed: it leaves an enabled one.
      await removeDeploymentAdmin(ghost.id, p.user.id);
      expect((await fresh(ghost.id)).deploymentAdmin).toBe(false);
    } finally {
      if (others.length) {
        await db
          .update(users)
          .set({ deploymentAdmin: true })
          .where(
            sql`${users.id} IN (${sql.join(
              others.map((o) => sql`${o.id}`),
              sql`, `,
            )})`,
          );
      }
      await db.update(users).set({ deploymentAdmin: false }).where(eq(users.id, p.user.id));
    }
  });
});

describe("the schedule", () => {
  it("runs only when on, and only once the interval has passed", async () => {
    await setDeploymentSetting(DIRECTORY_SYNC_ENABLED_KEY, false, null);
    expect(await runDirectorySyncIfDue()).toBe("off");
    await setDeploymentSetting(DIRECTORY_SYNC_ENABLED_KEY, true, null);
    await setDeploymentSetting(DIRECTORY_SYNC_INTERVAL_KEY, 15, null);
    await run();
    expect(await runDirectorySyncIfDue()).toBe("not_due");
    await db
      .update(directorySyncRuns)
      .set({ startedAt: sql`now() - interval '20 minutes'` })
      .where(sql`true`);
    expect(await runDirectorySyncIfDue()).toBe("ran");
    const [last] = await db
      .select()
      .from(directorySyncRuns)
      .orderBy(sql`${directorySyncRuns.startedAt} DESC`)
      .limit(1);
    expect(last!.trigger).toBe("schedule");
  });
});
