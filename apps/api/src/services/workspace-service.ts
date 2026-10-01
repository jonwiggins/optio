import { eq, and, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { workspaces, workspaceMembers, users } from "../db/schema.js";
import { revokeAllUserSessions } from "./session-service.js";
import type {
  Workspace,
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

  return ws as Workspace;
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id));
  return (ws as Workspace) ?? null;
}

export async function getWorkspaceBySlug(slug: string): Promise<Workspace | null> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, slug));
  return (ws as Workspace) ?? null;
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
  return (ws as Workspace) ?? null;
}

export async function deleteWorkspace(id: string): Promise<void> {
  await db.delete(workspaces).where(eq(workspaces.id, id));
}

/** List workspaces a user belongs to, with their role in each. */
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

  return rows as WorkspaceSummary[];
}

/** Get a user's role in a specific workspace, or null if not a member. */
export async function getUserRole(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return (row?.role as WorkspaceRole) ?? null;
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

  return rows as WorkspaceMemberWithUser[];
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

/** Remove a user from a workspace. Revokes sessions to prevent access with stale membership. */
export async function removeMember(workspaceId: string, userId: string): Promise<void> {
  await db
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  await revokeAllUserSessions(userId);
}

/**
 * Ensure a user has at least one workspace. If not, create a default one.
 * Returns the user's default workspace ID.
 */
export async function ensureUserHasWorkspace(userId: string): Promise<string> {
  // Check if user has a default workspace
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (user?.defaultWorkspaceId) {
    return user.defaultWorkspaceId;
  }

  // Check if user belongs to any workspace
  const memberships = await listUserWorkspaces(userId);
  if (memberships.length > 0) {
    await db
      .update(users)
      .set({ defaultWorkspaceId: memberships[0].id })
      .where(eq(users.id, userId));
    return memberships[0].id;
  }

  // Create a default workspace
  const ws = await createWorkspace(
    { name: "Default", slug: `ws-${userId.slice(0, 8)}`, description: "Default workspace" },
    userId,
  );
  return ws.id;
}

/** Switch a user's active workspace. Validates membership. */
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
]);

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
