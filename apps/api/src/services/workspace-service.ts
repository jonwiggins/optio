import { eq, and } from "drizzle-orm";
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
  },
): Promise<Workspace | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name;
  if (data.slug !== undefined) updates.slug = data.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (data.description !== undefined) updates.description = data.description;
  if (data.allowDockerInDocker !== undefined)
    updates.allowDockerInDocker = data.allowDockerInDocker;

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
