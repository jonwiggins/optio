/**
 * The Work list's vocabulary on the web. The server builds the rows
 * (`GET /api/work`, see `hooks/use-work-feed.ts`); the types and view helpers
 * are shared with it through @optio/shared.
 */

import type { WorkRow } from "@optio/shared";

export {
  countWork,
  inView,
  shortDir,
  shortRepo,
  sortWork,
  type WorkCounts,
  type WorkRow,
  type WorkSource,
  type WorkStatus,
  type WorkView,
} from "@optio/shared";

/**
 * Where the session screen (`/local/:id`, the terminal with every session in
 * its rail) should open from the Work list: the session that has waited on
 * you longest, else the most recently active one still running, else the
 * latest. Null when there are no sessions on your machines.
 */
export function sessionScreenTarget(rows: WorkRow[]): WorkRow | null {
  const sessions = rows.filter((r) => r.source === "local-terminal");
  const at = (r: WorkRow) => (r.lastActivity ? Date.parse(r.lastActivity) : 0);
  const oldestFirst = (a: WorkRow, b: WorkRow) => at(a) - at(b);
  const newestFirst = (a: WorkRow, b: WorkRow) => at(b) - at(a);
  return (
    sessions.filter((r) => r.status === "needs_you").sort(oldestFirst)[0] ??
    sessions.filter((r) => r.status === "running" || r.status === "waiting").sort(newestFirst)[0] ??
    [...sessions].sort(newestFirst)[0] ??
    null
  );
}
