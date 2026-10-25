import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  CreateTeamInput,
  Team,
  TeamDetail,
  TeamGroupMapping,
  TeamMember,
  TeamRole,
  UpdateTeamInput,
} from "@optio/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "../db/client.js";
import { teamGroupMappings, teamMembers, teams, users, workspaceMembers } from "../db/schema.js";
import { teamsEnabled } from "./deployment-settings.js";
import { logger } from "../logger.js";
import { isUniqueViolation } from "../utils/db-errors.js";
import type { Actor } from "./ownership.js";

/**
 * Teams inside a workspace (docs/teams.md): create one, ask to join, approve
 * or deny, run it, and keep it in step with the identity provider's groups.
 *
 * Who may do what:
 * - Any member of the workspace creates a team and becomes its first admin.
 * - A team admin, or a workspace admin, changes the team, decides join
 *   requests, adds and removes members, sets roles and group mappings.
 * - Anyone in the workspace asks to join (`open` teams admit at once;
 *   `closed` ones refuse) and leaves again.
 */

export class TeamError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "TeamError";
  }
}

type TeamRow = typeof teams.$inferSelect;
type MemberRow = typeof teamMembers.$inferSelect;

export interface TeamMembership {
  teamId: string;
  role: TeamRole;
}

/**
 * The teams `userId` is an active member of in `workspaceId`, with their
 * role — none while teams are off (Settings → Access → Teams): then nobody
 * is in a team, so team-owned rows read as their creators' and the scope
 * rules are the organization's and each person's alone.
 */
export async function teamMembershipsOf(
  userId: string,
  workspaceId: string,
): Promise<TeamMembership[]> {
  const rows = await db
    .select({ teamId: teamMembers.teamId, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(
      and(
        eq(teamMembers.userId, userId),
        eq(teamMembers.status, "active"),
        eq(teams.workspaceId, workspaceId),
      ),
    );
  if (rows.length === 0 || !(await teamsEnabled())) return [];
  return rows.map((r) => ({ teamId: r.teamId, role: r.role }));
}

export const TEAMS_OFF_MESSAGE =
  "Teams are turned off — a deployment admin turns them on under Settings → Access → Teams";

/**
 * A preHandler for every `/api/teams/...` route: 404 while teams are off, as
 * if the routes weren't there.
 */
export async function requireTeamsEnabled(_req: FastifyRequest, reply: FastifyReply) {
  if (!(await teamsEnabled())) return reply.status(404).send({ error: TEAMS_OFF_MESSAGE });
}

function slugOf(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "team";
}

async function freeSlug(workspaceId: string, base: string, exceptId?: string): Promise<string> {
  const taken = await db
    .select({ id: teams.id, slug: teams.slug })
    .from(teams)
    .where(and(eq(teams.workspaceId, workspaceId), sql`${teams.slug} LIKE ${base + "%"}`));
  const used = new Set(taken.filter((t) => t.id !== exceptId).map((t) => t.slug));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

function canManage(row: TeamRow, actor: Actor): boolean {
  return actor.isAdmin || (actor.adminTeamIds ?? []).includes(row.id);
}

async function requireTeam(id: string, actor: Actor): Promise<TeamRow> {
  const [row] = await db.select().from(teams).where(eq(teams.id, id));
  if (!row || row.workspaceId !== actor.workspaceId) throw new TeamError("Team not found", 404);
  return row;
}

async function requireManage(id: string, actor: Actor): Promise<TeamRow> {
  const row = await requireTeam(id, actor);
  if (!canManage(row, actor)) {
    throw new TeamError("Only the team's admins (or a workspace admin) can do that", 403);
  }
  return row;
}

async function toTeam(row: TeamRow, actor: Actor): Promise<Team> {
  const [counts] = await db
    .select({
      members: sql<number>`count(*) FILTER (WHERE ${teamMembers.status} = 'active')::int`,
      pending: sql<number>`count(*) FILTER (WHERE ${teamMembers.status} = 'requested')::int`,
    })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, row.id));
  const [mine] = actor.userId
    ? await db
        .select({ role: teamMembers.role, status: teamMembers.status })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, row.id), eq(teamMembers.userId, actor.userId)))
    : [];
  const manage = canManage(row, actor);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    joinPolicy: row.joinPolicy,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    memberCount: counts?.members ?? 0,
    pendingCount: manage ? (counts?.pending ?? 0) : 0,
    myRole: mine?.status === "active" ? mine.role : null,
    myStatus: mine?.status ?? null,
    canManage: manage,
  };
}

/** Every team in the actor's workspace. */
export async function listTeams(actor: Actor): Promise<Team[]> {
  if (!actor.workspaceId) return [];
  const rows = await db
    .select()
    .from(teams)
    .where(eq(teams.workspaceId, actor.workspaceId))
    .orderBy(teams.name);
  return Promise.all(rows.map((r) => toTeam(r, actor)));
}

async function membersOf(teamId: string): Promise<TeamMember[]> {
  const rows = await db
    .select({ m: teamMembers, u: users })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId))
    .orderBy(users.displayName);
  return rows.map(({ m, u }) => ({
    userId: m.userId,
    email: u.email,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    role: m.role,
    status: m.status,
    source: m.source,
    decidedBy: m.decidedBy,
    decidedAt: m.decidedAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  }));
}

export async function listGroupMappings(teamId: string): Promise<TeamGroupMapping[]> {
  const rows = await db
    .select({ groupName: teamGroupMappings.groupName, role: teamGroupMappings.role })
    .from(teamGroupMappings)
    .where(eq(teamGroupMappings.teamId, teamId))
    .orderBy(teamGroupMappings.groupName);
  return rows;
}

/** A team with its members; requests and group mappings for those who manage it. */
export async function getTeam(id: string, actor: Actor): Promise<TeamDetail> {
  const row = await requireTeam(id, actor);
  const team = await toTeam(row, actor);
  const members = await membersOf(id);
  return {
    ...team,
    members: team.canManage ? members : members.filter((m) => m.status === "active"),
    groupMappings: team.canManage ? await listGroupMappings(id) : undefined,
  };
}

export async function createTeam(input: CreateTeamInput, actor: Actor): Promise<TeamDetail> {
  if (!actor.workspaceId) throw new TeamError("Pick a workspace first", 400);
  const name = input.name.trim();
  if (!name) throw new TeamError("A team needs a name");
  const [dup] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(
      and(
        eq(teams.workspaceId, actor.workspaceId),
        sql`lower(${teams.name}) = ${name.toLowerCase()}`,
      ),
    );
  if (dup) throw new TeamError(`There's already a team called ${name}`, 409);
  const created = await db
    .transaction(async (tx) => {
      const [row] = await tx
        .insert(teams)
        .values({
          workspaceId: actor.workspaceId!,
          name,
          slug: await freeSlug(actor.workspaceId!, slugOf(name)),
          description: input.description?.trim() || null,
          joinPolicy: input.joinPolicy ?? "request",
          createdBy: actor.userId,
        })
        .returning();
      if (actor.userId) {
        await tx.insert(teamMembers).values({
          teamId: row.id,
          userId: actor.userId,
          role: "admin",
          status: "active",
          source: "manual",
          decidedBy: actor.userId,
          decidedAt: new Date(),
        });
      }
      return row;
    })
    .catch((err: unknown) => {
      // Someone made a team with that name (or slug) at the same moment.
      if (isUniqueViolation(err)) throw new TeamError(`There's already a team called ${name}`, 409);
      throw err;
    });
  logger.info({ teamId: created.id, userId: actor.userId }, "Team created");
  // The creator administers it from now on.
  const self: Actor = { ...actor, adminTeamIds: [...(actor.adminTeamIds ?? []), created.id] };
  return getTeam(created.id, { ...self, teamIds: [...(self.teamIds ?? []), created.id] });
}

export async function updateTeam(
  id: string,
  input: UpdateTeamInput,
  actor: Actor,
): Promise<TeamDetail> {
  const row = await requireManage(id, actor);
  const updates: Partial<typeof teams.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new TeamError("A team needs a name");
    const [dup] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(
          eq(teams.workspaceId, row.workspaceId),
          sql`lower(${teams.name}) = ${name.toLowerCase()}`,
        ),
      );
    if (dup && dup.id !== id) throw new TeamError(`There's already a team called ${name}`, 409);
    updates.name = name;
    updates.slug = await freeSlug(row.workspaceId, slugOf(name), id);
  }
  if (input.description !== undefined) updates.description = input.description?.trim() || null;
  if (input.joinPolicy !== undefined) updates.joinPolicy = input.joinPolicy;
  await db.update(teams).set(updates).where(eq(teams.id, id));
  return getTeam(id, actor);
}

export async function deleteTeam(id: string, actor: Actor): Promise<void> {
  await requireManage(id, actor);
  await db.delete(teams).where(eq(teams.id, id));
  logger.info({ teamId: id, userId: actor.userId }, "Team deleted");
}

// ── Joining ─────────────────────────────────────────────────────────────────

/** Ask to join (or join at once, for an open team). */
export async function requestToJoin(id: string, actor: Actor): Promise<TeamDetail> {
  const row = await requireTeam(id, actor);
  if (!actor.userId) throw new TeamError("Sign in first", 403);
  const [existing] = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, actor.userId)));
  if (existing?.status === "active") throw new TeamError("You're already in this team", 409);
  if (existing?.status === "requested") throw new TeamError("Your request is waiting", 409);
  if (row.joinPolicy === "closed" && !canManage(row, actor)) {
    throw new TeamError("This team's admins add members themselves", 403);
  }
  const admit = row.joinPolicy === "open" || canManage(row, actor);
  const values = {
    role: "member" as const,
    status: admit ? ("active" as const) : ("requested" as const),
    source: "manual" as const,
    decidedBy: admit ? actor.userId : null,
    decidedAt: admit ? new Date() : null,
  };
  if (existing) {
    await db
      .update(teamMembers)
      .set(values)
      .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, actor.userId)));
  } else {
    await db.insert(teamMembers).values({ teamId: id, userId: actor.userId, ...values });
  }
  return getTeam(id, admit ? { ...actor, teamIds: [...(actor.teamIds ?? []), id] } : actor);
}

/** Leave the team, or withdraw a request. The last admin can't leave. */
export async function leaveTeam(id: string, actor: Actor): Promise<void> {
  await requireTeam(id, actor);
  if (!actor.userId) throw new TeamError("Sign in first", 403);
  await assertNotLastAdmin(id, actor.userId);
  await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, actor.userId)));
}

async function assertNotLastAdmin(teamId: string, userId: string): Promise<void> {
  const admins = await db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.status, "active"),
        eq(teamMembers.role, "admin"),
      ),
    );
  if (admins.length === 1 && admins[0].userId === userId) {
    throw new TeamError("Make someone else a team admin first — a team keeps at least one", 400);
  }
}

export async function decideRequest(
  id: string,
  userId: string,
  decision: "approve" | "deny",
  actor: Actor,
): Promise<TeamDetail> {
  await requireManage(id, actor);
  const [existing] = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, userId)));
  if (!existing || existing.status !== "requested") {
    throw new TeamError("No request from that person is waiting", 404);
  }
  await db
    .update(teamMembers)
    .set({
      status: decision === "approve" ? "active" : "denied",
      decidedBy: actor.userId,
      decidedAt: new Date(),
    })
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, userId)));
  return getTeam(id, actor);
}

/** Add someone straight away (by user id or email), as member or admin. */
export async function addMember(
  id: string,
  who: { userId?: string; email?: string },
  role: TeamRole,
  actor: Actor,
): Promise<TeamDetail> {
  const team = await requireManage(id, actor);
  const [user] = who.userId
    ? await db.select({ id: users.id }).from(users).where(eq(users.id, who.userId))
    : who.email
      ? await db
          .select({ id: users.id })
          .from(users)
          .where(sql`lower(${users.email}) = ${who.email.trim().toLowerCase()}`)
      : [];
  if (!user) throw new TeamError("No one with that email has signed in yet", 404);
  // A team lives in one workspace: its members are that workspace's people.
  if (team.workspaceId) {
    const [member] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, team.workspaceId),
          eq(workspaceMembers.userId, user.id),
        ),
      );
    if (!member) throw new TeamError("They aren't a member of this team's workspace", 404);
  }
  await db
    .insert(teamMembers)
    .values({
      teamId: id,
      userId: user.id,
      role,
      status: "active",
      source: "manual",
      decidedBy: actor.userId,
      decidedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [teamMembers.teamId, teamMembers.userId],
      set: {
        role,
        status: "active",
        source: "manual",
        decidedBy: actor.userId,
        decidedAt: new Date(),
      },
    });
  return getTeam(id, actor);
}

export async function setMemberRole(
  id: string,
  userId: string,
  role: TeamRole,
  actor: Actor,
): Promise<TeamDetail> {
  await requireManage(id, actor);
  if (role === "member") await assertNotLastAdmin(id, userId);
  const updated = await db
    .update(teamMembers)
    .set({ role, source: "manual" })
    .where(
      and(
        eq(teamMembers.teamId, id),
        eq(teamMembers.userId, userId),
        eq(teamMembers.status, "active"),
      ),
    )
    .returning({ userId: teamMembers.userId });
  if (updated.length === 0) throw new TeamError("Not a member of this team", 404);
  return getTeam(id, actor);
}

export async function removeMember(id: string, userId: string, actor: Actor): Promise<TeamDetail> {
  await requireManage(id, actor);
  await assertNotLastAdmin(id, userId);
  await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, userId)));
  return getTeam(id, actor);
}

// ── SSO groups ──────────────────────────────────────────────────────────────

export async function setGroupMappings(
  id: string,
  mappings: TeamGroupMapping[],
  actor: Actor,
): Promise<TeamDetail> {
  await requireManage(id, actor);
  const clean = new Map<string, TeamRole>();
  for (const m of mappings) {
    const name = m.groupName.trim();
    if (name) clean.set(name.toLowerCase(), m.role);
  }
  await db.transaction(async (tx) => {
    await tx.delete(teamGroupMappings).where(eq(teamGroupMappings.teamId, id));
    const values = [...clean.entries()].map(([groupName, role]) => ({
      teamId: id,
      groupName,
      role,
    }));
    if (values.length > 0) await tx.insert(teamGroupMappings).values(values);
  });
  return getTeam(id, actor);
}

/**
 * After a sign-in: the person joins every team (in `workspaceId`) whose
 * group mappings name one of their groups, with the mapped role, and leaves
 * the SSO-sourced memberships whose group no longer matches. Memberships
 * made by hand are never touched.
 */
export async function syncTeamsFromGroups(
  userId: string,
  workspaceId: string,
  groups: string[],
): Promise<{ joined: string[]; left: string[] }> {
  const mine = new Set(groups.map((g) => g.toLowerCase()));
  const mappings = await db
    .select({
      teamId: teamGroupMappings.teamId,
      groupName: teamGroupMappings.groupName,
      role: teamGroupMappings.role,
    })
    .from(teamGroupMappings)
    .innerJoin(teams, eq(teams.id, teamGroupMappings.teamId))
    .where(eq(teams.workspaceId, workspaceId));
  // The role a team gives this person: admin if any matching mapping says so.
  const wanted = new Map<string, TeamRole>();
  for (const m of mappings) {
    if (!mine.has(m.groupName.toLowerCase())) continue;
    const current = wanted.get(m.teamId);
    wanted.set(m.teamId, current === "admin" || m.role === "admin" ? "admin" : "member");
  }
  const existing = await db
    .select()
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teamMembers.userId, userId), eq(teams.workspaceId, workspaceId)));
  const byTeam = new Map<string, MemberRow>(
    existing.map((r) => [r.team_members.teamId, r.team_members]),
  );

  const joined: string[] = [];
  const left: string[] = [];
  for (const [teamId, role] of wanted) {
    const row = byTeam.get(teamId);
    if (row?.status === "active" && row.source === "manual") continue;
    if (row?.status === "active" && row.source === "sso" && row.role === role) continue;
    await db
      .insert(teamMembers)
      .values({ teamId, userId, role, status: "active", source: "sso", decidedAt: new Date() })
      .onConflictDoUpdate({
        target: [teamMembers.teamId, teamMembers.userId],
        set: { role, status: "active", source: "sso", decidedAt: new Date() },
      });
    if (row?.status !== "active") joined.push(teamId);
  }
  const stale = [...byTeam.values()].filter(
    (r) => r.source === "sso" && r.status === "active" && !wanted.has(r.teamId),
  );
  if (stale.length > 0) {
    await db.delete(teamMembers).where(
      and(
        eq(teamMembers.userId, userId),
        inArray(
          teamMembers.teamId,
          stale.map((r) => r.teamId),
        ),
        eq(teamMembers.source, "sso"),
      ),
    );
    left.push(...stale.map((r) => r.teamId));
  }
  return { joined, left };
}
