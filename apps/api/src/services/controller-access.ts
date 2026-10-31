import { eq, isNull, type Column } from "drizzle-orm";
import { canUse, knowsTeams } from "./ownership.js";
import { canSeeWork } from "./work-visibility.js";
import type { ControllerPrincipal } from "./controller-auth.js";

export class ControllerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export const tenant = (column: Column, workspaceId: string | null) =>
  workspaceId === null ? isNull(column) : eq(column, workspaceId);

export function requireManage(p: ControllerPrincipal) {
  if (p.access !== "manage")
    throw new ControllerError(403, "This connection has read-only controller access");
}

type Scoped = {
  workspaceId: string | null;
  ownerUserId?: string | null;
  ownerTeamId?: string | null;
  createdBy?: string | null;
  runTarget?: string;
};
export function requireVisible(
  p: ControllerPrincipal,
  row: Scoped | null | undefined,
): asserts row is Scoped {
  if (!row || row.workspaceId !== p.actor.workspaceId || !canSeeWork(row, p.actor))
    throw new ControllerError(404, "Work not found");
}
export function requireChange(p: ControllerPrincipal, row: Scoped) {
  requireManage(p);
  requireVisible(p, row);
  if (row.runTarget === "local" && (!p.run?.sessionId || row.ownerUserId !== p.actor.userId))
    throw new ControllerError(403, "Controller tools cannot operate work on a machine");
  if (p.actor.executionTeamId && row.ownerTeamId !== p.actor.executionTeamId)
    throw new ControllerError(403, "A team controller can change only its team's work");
  // Teams off: a team's work is its creator's, as the HTTP routes read it.
  const teamAware = !!p.actor.executionTeamId || knowsTeams(p.actor);
  const team =
    p.actor.executionTeamId ??
    ((p.actor.teamIds ?? []).includes(row.ownerTeamId ?? "") ? row.ownerTeamId : null);
  if (
    teamAware
      ? !canUse(row.ownerUserId, p.actor.userId, row.ownerTeamId, team)
      : !canUse(row.ownerUserId, p.actor.userId)
  )
    throw new ControllerError(403, "Only its owner can change or run private work");
}
