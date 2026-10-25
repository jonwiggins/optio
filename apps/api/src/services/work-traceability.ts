/**
 * What a run tells GitLab about where its work came from (docs/ticket-round-trip.md
 * "Traceable merge requests and commits"): the Jira key, who asked, the team
 * and the run's page, for the MR title and footer (prompt variables) and the
 * commit trailers (the run's environment, read by the hook in
 * commit-trailers.ts). The text rules are in @optio/shared
 * (work-traceability.ts); this file looks the people up.
 *
 * Who asked: for ticket work, the ticket's reporter as the sync saw them
 * (`metadata.ticketReporter`; a Server that hides emails gives a name and no
 * Co-authored-by); for other work, the person who made it. The run's page is
 * `<PUBLIC_URL>/work/<id>`, left out while PUBLIC_URL is unset.
 *
 * Off unless the deployment turns it on: OPTIO_WORK_TRACEABILITY=true (Helm
 * `tickets.traceability`). Off, the MR and the commits are as the prompt
 * alone makes them. On, OPTIO_COMMIT_TRAILERS=false (Helm
 * `tickets.commitTrailers`) still leaves the commit trailers out; the MR
 * title and footer stay.
 */
import { eq } from "drizzle-orm";
import {
  commitTrailerEnv,
  commitTrailers,
  mrFooter,
  mrTitle,
  oneLine,
  traceabilityPromptVars,
  type WorkTrace,
} from "@optio/shared";
import { db } from "../db/client.js";
import { teams, users } from "../db/schema.js";
import { logger } from "../logger.js";
import { absoluteLink, workPath } from "./notify/templates.js";

export interface TraceableTask {
  id: string;
  title: string;
  ticketSource?: string | null;
  ticketExternalId?: string | null;
  metadata?: unknown;
  createdBy?: string | null;
  ownerUserId?: string | null;
  ownerTeamId?: string | null;
}

/** Whether runs say where their work came from at all (OPTIO_WORK_TRACEABILITY, default off). */
export function workTraceabilityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OPTIO_WORK_TRACEABILITY ?? "").trim().toLowerCase() === "true";
}

/** Whether commits get trailers (with traceability on; OPTIO_COMMIT_TRAILERS, default on). */
export function commitTrailersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!workTraceabilityEnabled(env)) return false;
  return (env.OPTIO_COMMIT_TRAILERS ?? "").trim().toLowerCase() !== "false";
}

/** `<PUBLIC_URL>/work/<id>`, or null while PUBLIC_URL is unset. */
export function runUrlOf(taskId: string): string | null {
  return absoluteLink(workPath({ id: taskId, kind: "repo" }));
}

function metaOf(task: TraceableTask): Record<string, unknown> {
  return task.metadata && typeof task.metadata === "object"
    ? (task.metadata as Record<string, unknown>)
    : {};
}

/** The ticket reporter the sync stored, as a requester (a name, maybe an email). */
function reporterOf(task: TraceableTask): WorkTrace["requester"] {
  const r = metaOf(task).ticketReporter as { name?: unknown; email?: unknown } | undefined;
  const name = typeof r?.name === "string" ? oneLine(r.name, 120) : "";
  const email = typeof r?.email === "string" ? r.email : null;
  return name || email ? { name: name || (email ?? ""), email } : null;
}

async function personOf(userId: string | null | undefined): Promise<WorkTrace["requester"]> {
  if (!userId) return null;
  const [u] = await db
    .select({ displayName: users.displayName, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  return u ? { name: u.displayName, email: u.email } : null;
}

/** Everything the MR and the commits say about this work. */
export async function workTrace(task: TraceableTask): Promise<WorkTrace> {
  const meta = metaOf(task);
  const requester = task.ticketSource
    ? reporterOf(task)
    : await personOf(task.createdBy ?? task.ownerUserId);
  let teamName: string | null = null;
  if (task.ownerTeamId) {
    const [t] = await db
      .select({ name: teams.name })
      .from(teams)
      .where(eq(teams.id, task.ownerTeamId));
    teamName = t?.name ?? null;
  }
  return {
    title: task.title,
    ticketSource: task.ticketSource ?? null,
    ticketKey: task.ticketExternalId ?? null,
    ticketUrl: typeof meta.ticketUrl === "string" ? meta.ticketUrl : null,
    requester,
    teamName,
    runUrl: runUrlOf(task.id),
  };
}

/**
 * The prompt variables and the run's environment for `task`. Never throws:
 * a lookup that fails leaves the MR and commits as upstream makes them.
 */
export async function workTraceability(
  task: TraceableTask,
): Promise<{ promptVars: Record<string, string>; env: Record<string, string> }> {
  if (!workTraceabilityEnabled()) return { promptVars: {}, env: {} };
  try {
    const trace = await workTrace(task);
    const promptVars = traceabilityPromptVars(trace);
    if (!commitTrailersEnabled())
      return { promptVars: { ...promptVars, COMMIT_TRAILERS: "" }, env: {} };
    return { promptVars, env: commitTrailerEnv(trace) };
  } catch (err) {
    logger.warn({ err, taskId: task.id }, "Could not look up the work's requester and team");
    return { promptVars: {}, env: {} };
  }
}

/**
 * For a run in a person's own checkout (Optio Local, a remote workspace),
 * where Optio installs no hook: the MR title, its footer and the commit
 * trailers as an instruction appended to the prompt. "" when there is
 * nothing to say. Never throws.
 */
export async function localTraceabilityNote(task: TraceableTask): Promise<string> {
  if (!workTraceabilityEnabled()) return "";
  try {
    const trace = await workTrace(task);
    const lines: string[] = [];
    const title = mrTitle(trace);
    if (title !== oneLine(trace.title, 240)) lines.push(`Title the merge request "${title}".`);
    const footer = mrFooter(trace);
    if (footer) lines.push(`End the merge request's description with:\n\n${footer}`);
    const trailers = commitTrailersEnabled() ? commitTrailers(trace) : [];
    if (trailers.length) {
      lines.push(
        `End every commit message with these trailers (once):\n\n${trailers.map(([k, v]) => `${k}: ${v}`).join("\n")}`,
      );
    }
    return lines.length ? `\n\n${lines.join("\n\n")}` : "";
  } catch (err) {
    logger.warn({ err, taskId: task.id }, "Could not look up the work's requester and team");
    return "";
  }
}
