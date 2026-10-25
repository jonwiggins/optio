/**
 * Teams: a third scope next to the organization and one person. A team's
 * members see and use what it owns (secrets, model gateways, connections,
 * prompts, work…); its admins change it. People create teams and ask to
 * join; the identity provider's groups can fill them. See docs/teams.md.
 */

export type TeamRole = "admin" | "member";
export type TeamMemberStatus = "active" | "requested" | "denied";
export type TeamJoinPolicy = "open" | "request" | "closed";

export const TEAM_JOIN_POLICY_LABEL: Record<TeamJoinPolicy, string> = {
  open: "Anyone in the workspace can join",
  request: "People ask to join; a team admin approves",
  closed: "Members are added by an admin (or by SSO groups)",
};

export interface Team {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string | null;
  joinPolicy: TeamJoinPolicy;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Active members. */
  memberCount: number;
  /** Join requests waiting (team admins and workspace admins only; else 0). */
  pendingCount: number;
  /** The viewer's own standing in the team. */
  myRole: TeamRole | null;
  myStatus: TeamMemberStatus | null;
  /** Whether the viewer may change the team (a team admin or a workspace admin). */
  canManage: boolean;
}

export interface TeamMember {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: TeamRole;
  status: TeamMemberStatus;
  source: "manual" | "sso";
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface TeamGroupMapping {
  groupName: string;
  role: TeamRole;
}

export interface TeamDetail extends Team {
  members: TeamMember[];
  /** Group → team mappings (team admins and workspace admins only). */
  groupMappings?: TeamGroupMapping[];
}

export interface CreateTeamInput {
  name: string;
  description?: string | null;
  joinPolicy?: TeamJoinPolicy;
}

export interface UpdateTeamInput {
  name?: string;
  description?: string | null;
  joinPolicy?: TeamJoinPolicy;
}

/** The `team:<id>` form of a `ResourceOwner`. */
export const TEAM_OWNER_PREFIX = "team:";

export function teamOwner(teamId: string): `team:${string}` {
  return `${TEAM_OWNER_PREFIX}${teamId}`;
}

/** The team id a `ResourceOwner` names, or null for the organization / a person. */
export function teamIdOf(owner: string | null | undefined): string | null {
  if (!owner || !owner.startsWith(TEAM_OWNER_PREFIX)) return null;
  const id = owner.slice(TEAM_OWNER_PREFIX.length);
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

/** A `ResourceOwner` body value is well-formed. */
export function isResourceOwner(value: unknown): value is "workspace" | "me" | `team:${string}` {
  return (
    value === "workspace" || value === "me" || (typeof value === "string" && !!teamIdOf(value))
  );
}
