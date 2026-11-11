import { randomBytes } from "node:crypto";
import { eq, and, asc, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { workspaces, workspaceMembers, users } from "../db/schema.js";
import { revokeAllUserSessions } from "./session-service.js";
import { deleteWorkspaceDefinitions } from "./work-definition-service.js";
import { envDeploymentAdmins, holdsDeploymentAdmin } from "./deployment-admin-grant.js";
import { DEPLOYMENT_ADMINS_ALL_WORKSPACES, switchEnabled } from "./deployment-settings.js";
import type {
  Workspace,
  WorkspaceDeploymentAdmin,
  WorkspaceMemberWithUser,
  WorkspaceRole,
  WorkspaceSummary,
} from "@optio/shared";

export async function createWorkspace(
  data: { name: string; slug: string; description?: string },
  createdBy?: string,
): Promise<Workspace> {
  const [ws] = await db
    .insert(workspaces)
    .values({
      name: data.name,
      slug: data.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      description: data.description,
      createdBy,
    })
    .returning();

  // Add creator as admin
  if (createdBy) {
    await db.insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: createdBy,
      role: "admin",
    });

    // Set as default workspace if user doesn't have one
    const [user] = await db.select().from(users).where(eq(users.id, createdBy));
    if (user && !user.defaultWorkspaceId) {
      await db.update(users).set({ defaultWorkspaceId: ws.id }).where(eq(users.id, createdBy));
    }
  }

  return ws;
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id));
  return ws ?? null;
}

export async function getWorkspaceBySlug(slug: string): Promise<Workspace | null> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, slug));
  return ws ?? null;
}

export async function updateWorkspace(
  id: string,
  data: {
    name?: string;
    slug?: string;
    description?: string | null;
    allowDockerInDocker?: boolean;
    autoJoinDomains?: string[];
    autoJoinRole?: WorkspaceRole;
    restrictPodSecrets?: boolean;
  },
): Promise<Workspace | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name;
  if (data.slug !== undefined) updates.slug = data.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (data.description !== undefined) updates.description = data.description;
  if (data.allowDockerInDocker !== undefined)
    updates.allowDockerInDocker = data.allowDockerInDocker;
  if (data.autoJoinDomains !== undefined) {
    const normalized = normalizeAutoJoinDomains(data.autoJoinDomains);
    if ("error" in normalized) throw new WorkspaceSettingsError(normalized.error);
    updates.autoJoinDomains = normalized.domains;
  }
  if (data.autoJoinRole !== undefined) {
    if (data.autoJoinRole === "admin") {
      throw new WorkspaceSettingsError("People joining by email domain can't be admins");
    }
    updates.autoJoinRole = data.autoJoinRole;
  }
  if (data.restrictPodSecrets !== undefined) updates.restrictPodSecrets = data.restrictPodSecrets;

  const [ws] = await db.update(workspaces).set(updates).where(eq(workspaces.id, id)).returning();
  return ws ?? null;
}

/** Delete a workspace, and with it its scheduled Tasks and Jobs (and their triggers). */
export async function deleteWorkspace(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await deleteWorkspaceDefinitions(id, tx);
    await tx.delete(workspaces).where(eq(workspaces.id, id));
  });
}

/**
 * The workspaces a user may work in, with their role in each: the ones they
 * belong to — and, for a deployment admin while deployment admins are admins
 * of every workspace ({@link DEPLOYMENT_ADMINS_ALL_WORKSPACES}), every other
 * one too, as admin, marked `viaDeploymentAdmin`. Memberships come first, the
 * rest by name.
 */
export async function listUserWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, userId));
  const memberships = rows as WorkspaceSummary[];
  if (!(await administersAllWorkspaces(userId))) return memberships;

  const all = await db
    .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
    .from(workspaces)
    .orderBy(asc(workspaces.name), asc(workspaces.id));
  const role = new Map(memberships.map((m) => [m.id, m.role]));
  const listed: WorkspaceSummary[] = memberships.map((m) =>
    m.role === "admin" ? m : { ...m, role: "admin", viaDeploymentAdmin: true },
  );
  for (const ws of all) {
    if (!role.has(ws.id)) listed.push({ ...ws, role: "admin", viaDeploymentAdmin: true });
  }
  return listed;
}

/**
 * A user's own membership role in a workspace, or null if they aren't a
 * member — never the deployment-admin grant. For questions about who is *in*
 * a workspace (an admin acting on another person's private rows checks the
 * person belongs to it); use {@link getUserRole} for what a caller may do.
 */
export async function getMembershipRole(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return row?.role ?? null;
}

/** The role a user acts with in a workspace, and whether it comes from the deployment-admin grant. */
export interface WorkspaceAccess {
  role: WorkspaceRole;
  /** Admin because they are a deployment admin, not by their membership (none, or a lower role). */
  viaDeploymentAdmin: boolean;
}

/**
 * The role a user acts with in a workspace, or null when they have none
 * there: their membership's — or `admin` for a deployment admin while
 * deployment admins are admins of every workspace
 * ({@link DEPLOYMENT_ADMINS_ALL_WORKSPACES}: Settings → Access over Helm's
 * default), whether or not they belong to it and whatever lower role they
 * hold in it. The grant is read on every call (the switch is remembered for a
 * few seconds), so taking the role away or turning the switch off takes the
 * access away; nothing is stored on the workspace.
 */
export async function getWorkspaceAccess(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceAccess | null> {
  if (!(await switchEnabled(DEPLOYMENT_ADMINS_ALL_WORKSPACES))) {
    const role = await getMembershipRole(workspaceId, userId);
    return role ? { role, viaDeploymentAdmin: false } : null;
  }
  // One query: the membership (if any), the account's grant, and whether the
  // workspace exists at all (a deployment admin is admin of real ones only).
  const [row] = await db
    .select({
      role: workspaceMembers.role,
      workspaceId: workspaces.id,
      deploymentAdmin: users.deploymentAdmin,
      email: users.email,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .leftJoin(workspaces, eq(workspaces.id, workspaceId))
    .leftJoin(
      workspaceMembers,
      and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, users.id)),
    )
    .where(eq(users.id, userId));
  if (!row?.workspaceId) return null;
  const membership = row.role ?? null;
  if (holdsDeploymentAdmin(row)) {
    return { role: "admin", viaDeploymentAdmin: membership !== "admin" };
  }
  return membership ? { role: membership, viaDeploymentAdmin: false } : null;
}

/** {@link getWorkspaceAccess}'s role alone: what a caller may do in the workspace. */
export async function getUserRole(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  return (await getWorkspaceAccess(workspaceId, userId))?.role ?? null;
}

/** Whether `userId` is a deployment admin while deployment admins are admins of every workspace. */
async function administersAllWorkspaces(userId: string): Promise<boolean> {
  if (!(await switchEnabled(DEPLOYMENT_ADMINS_ALL_WORKSPACES))) return false;
  const [row] = await db
    .select({
      deploymentAdmin: users.deploymentAdmin,
      email: users.email,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(eq(users.id, userId));
  return !!row && holdsDeploymentAdmin(row);
}

/**
 * The deployment admins who are admins of `workspaceId` through the grant —
 * every deployment admin, while deployment admins are admins of every
 * workspace, with their own membership role there (null: not a member).
 * Empty while the switch is off. For the workspace's members list, so its
 * people see everyone who can act in it.
 */
export async function listWorkspaceDeploymentAdmins(
  workspaceId: string,
): Promise<WorkspaceDeploymentAdmin[]> {
  if (!(await switchEnabled(DEPLOYMENT_ADMINS_ALL_WORKSPACES))) return [];
  const listed = [...envDeploymentAdmins()];
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      membershipRole: workspaceMembers.role,
    })
    .from(users)
    .leftJoin(
      workspaceMembers,
      and(eq(workspaceMembers.userId, users.id), eq(workspaceMembers.workspaceId, workspaceId)),
    )
    .where(
      listed.length > 0
        ? sql`(${users.deploymentAdmin} = true OR (${users.emailVerified} = true AND lower(${users.email}) IN (${sql.join(
            listed.map((e) => sql`${e}`),
            sql`, `,
          )})))`
        : eq(users.deploymentAdmin, true),
    )
    .orderBy(asc(users.displayName), asc(users.id));
  return rows.map((r) => ({ ...r, membershipRole: (r.membershipRole as WorkspaceRole) ?? null }));
}

/** List all members of a workspace. */
export async function listMembers(workspaceId: string): Promise<WorkspaceMemberWithUser[]> {
  const rows = await db
    .select({
      id: workspaceMembers.id,
      workspaceId: workspaceMembers.workspaceId,
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      createdAt: workspaceMembers.createdAt,
      email: users.email,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(eq(workspaceMembers.workspaceId, workspaceId));

  return rows;
}

/**
 * Add a user to a workspace. Throws "User not found" if the target user
 * does not exist, and "User is already a member" if the membership already
 * exists. Use {@link updateMemberRole} to change an existing member's role.
 */
export async function addMember(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole = "member",
): Promise<void> {
  // Validate user exists
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!user) {
    throw new Error("User not found");
  }

  // onConflictDoNothing + returning lets us distinguish a fresh insert from
  // an existing membership without racing against concurrent admins.
  const inserted = await db
    .insert(workspaceMembers)
    .values({ workspaceId, userId, role })
    .onConflictDoNothing({
      target: [workspaceMembers.workspaceId, workspaceMembers.userId],
    })
    .returning({ id: workspaceMembers.id });

  if (inserted.length === 0) {
    throw new Error("User is already a member of this workspace");
  }
}

/** Update a member's role. Revokes sessions to force re-authentication with updated privileges. */
export async function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<void> {
  await db
    .update(workspaceMembers)
    .set({ role })
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  await revokeAllUserSessions(userId);
}

/**
 * Remove a user from a workspace. Revokes sessions to prevent access with
 * stale membership, and forgets the workspace as their default so nothing
 * falls back to it.
 */
export async function removeMember(workspaceId: string, userId: string): Promise<void> {
  await db
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  await db
    .update(users)
    .set({ defaultWorkspaceId: null, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.defaultWorkspaceId, workspaceId)));
  await revokeAllUserSessions(userId);
}

/**
 * Whether a person who belongs to no workspace may be given a new one of
 * their own: when everyone may create workspaces (`workspaces.creation`, the
 * default), or they are a deployment admin. Otherwise they wait to be added,
 * or join one by their verified email's domain.
 */
async function mayGetOwnWorkspace(userId: string): Promise<boolean> {
  const { workspaceCreationPolicy } = await import("./deployment-settings.js");
  if ((await workspaceCreationPolicy()).value === "everyone") return true;
  const { isDeploymentAdmin } = await import("./sign-in-config-service.js");
  return isDeploymentAdmin({ id: userId });
}

/**
 * The workspace a request that names none works in: the user's saved default
 * while they are still a member of it; else their oldest membership (saved as
 * the new default); else, when they may have one (`mayGetOwnWorkspace`), a new
 * "Default" workspace they administer. Null when they belong to none and may
 * not create one — never a workspace they aren't a member of.
 */
export async function ensureUserHasWorkspace(userId: string): Promise<string | null> {
  const [user] = await db
    .select({ defaultWorkspaceId: users.defaultWorkspaceId })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return null;
  if (user.defaultWorkspaceId && (await getUserRole(user.defaultWorkspaceId, userId))) {
    return user.defaultWorkspaceId;
  }

  const [membership] = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.workspaceId))
    .limit(1);
  if (membership) {
    await db
      .update(users)
      .set({ defaultWorkspaceId: membership.workspaceId })
      .where(eq(users.id, userId));
    return membership.workspaceId;
  }

  // A default that no longer holds (removed, or the workspace deleted).
  if (user.defaultWorkspaceId) {
    await db.update(users).set({ defaultWorkspaceId: null }).where(eq(users.id, userId));
  }
  if (!(await mayGetOwnWorkspace(userId))) return null;

  const base = `ws-${userId.slice(0, 8)}`;
  const slug = (await getWorkspaceBySlug(base))
    ? `${base}-${randomBytes(3).toString("hex")}`
    : base;
  const ws = await createWorkspace(
    { name: "Default", slug, description: "Default workspace" },
    userId,
  );
  return ws.id;
}

/**
 * Switch a user's active workspace. Validates that they have a role there
 * (a membership, or the deployment-admin grant — {@link getUserRole}).
 */
export async function switchWorkspace(userId: string, workspaceId: string): Promise<void> {
  const role = await getUserRole(workspaceId, userId);
  if (!role) {
    throw new Error("Not a member of this workspace");
  }
  await db
    .update(users)
    .set({ defaultWorkspaceId: workspaceId, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

// ── Sign-in by email domain ─────────────────────────────────────────────────

export class WorkspaceSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSettingsError";
  }
}

/** Domains anyone can get an address at: never a company's sign-in rule. */
const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "fastmail.com",
  "hey.com",
  "qq.com",
  "163.com",
  "users.noreply.github.com",
  "privaterelay.appleid.com",
  // Sign in with Apple relay addresses issued from late 2026 on.
  "private.icloud.com",
]);

/**
 * The domain of the user's email when their sign-in provider verified the
 * address (`users.email_verified`), else null: an address nobody vouched for
 * is no claim on its domain.
 */
export async function verifiedEmailDomain(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ email: users.email, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, userId));
  if (!row?.emailVerified) return null;
  return row.email.split("@")[1]?.trim().toLowerCase() || null;
}

/** Lowercased, deduplicated domains; an error for one that isn't a company domain. */
export function normalizeAutoJoinDomains(
  domains: string[],
): { domains: string[] } | { error: string } {
  const out = new Set<string>();
  for (const raw of domains) {
    const d = raw.trim().toLowerCase().replace(/^@/, "");
    if (!d) continue;
    if (!/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) {
      return { error: `"${raw}" isn't an email domain (like acme.com)` };
    }
    if (PUBLIC_EMAIL_DOMAINS.has(d)) {
      return { error: `Anyone can get a ${d} address — use your company's own domain` };
    }
    out.add(d);
  }
  if (out.size > 20) return { error: "At most 20 domains" };
  return { domains: [...out].sort() };
}

/**
 * After a sign-in: join every workspace that lets people with this verified
 * email's domain in, with its join role. Existing memberships are kept as
 * they are. A first-time user's default workspace becomes the first one
 * joined (so they never get an empty personal one). Returns the ids joined.
 */
export async function joinWorkspacesByEmailDomain(
  userId: string,
  email: string,
  emailVerified: boolean,
): Promise<string[]> {
  if (!emailVerified) return [];
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain || PUBLIC_EMAIL_DOMAINS.has(domain)) return [];
  const matching = await db
    .select({ id: workspaces.id, role: workspaces.autoJoinRole })
    .from(workspaces)
    .where(sql`${workspaces.autoJoinDomains} @> ${JSON.stringify([domain])}::jsonb`);
  const joined: string[] = [];
  for (const ws of matching) {
    const inserted = await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws.id, userId, role: ws.role === "admin" ? "member" : ws.role })
      .onConflictDoNothing({ target: [workspaceMembers.workspaceId, workspaceMembers.userId] })
      .returning({ id: workspaceMembers.id });
    if (inserted.length > 0) joined.push(ws.id);
  }
  if (joined.length > 0) {
    await db
      .update(users)
      .set({ defaultWorkspaceId: joined[0] })
      .where(and(eq(users.id, userId), isNull(users.defaultWorkspaceId)));
  }
  return joined;
}
