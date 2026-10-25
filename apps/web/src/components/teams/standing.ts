import type { Team, TeamJoinPolicy } from "@optio/shared";

/**
 * A team row from the viewer's side: where they stand in it, and the one
 * button the row offers them (join, ask, leave, withdraw — or nothing, with
 * the reason). The server is the judge; this only words what it will say.
 */

export type Standing = "admin" | "member" | "requested" | "denied" | "none";

export function standingOf(t: Pick<Team, "myRole" | "myStatus">): Standing {
  if (t.myStatus === "active") return t.myRole === "admin" ? "admin" : "member";
  if (t.myStatus === "requested") return "requested";
  if (t.myStatus === "denied") return "denied";
  return "none";
}

export const STANDING_LABEL: Record<Standing, string> = {
  admin: "Admin",
  member: "Member",
  requested: "Requested",
  denied: "Denied",
  none: "Not a member",
};

/** The short word a row shows for a join policy; `TEAM_JOIN_POLICY_LABEL` is the sentence. */
export const JOIN_POLICY_SHORT: Record<TeamJoinPolicy, string> = {
  open: "Open",
  request: "By request",
  closed: "Closed",
};

export type JoinAction =
  | { kind: "join"; label: string }
  | { kind: "request"; label: string }
  | { kind: "leave"; label: string }
  | { kind: "cancel"; label: string }
  | { kind: "none"; reason: string };

/** The one button a team row offers the viewer. */
export function joinAction(t: Pick<Team, "myRole" | "myStatus" | "joinPolicy">): JoinAction {
  const standing = standingOf(t);
  if (standing === "admin" || standing === "member") return { kind: "leave", label: "Leave" };
  if (standing === "requested") return { kind: "cancel", label: "Cancel request" };
  if (t.joinPolicy === "open") return { kind: "join", label: "Join" };
  if (t.joinPolicy === "request") {
    return { kind: "request", label: standing === "denied" ? "Ask again" : "Request to join" };
  }
  return { kind: "none", reason: "An admin adds members" };
}
