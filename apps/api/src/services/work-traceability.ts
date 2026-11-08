/**
 * What a run tells the git host about where its work came from: the Jira
 * key, who asked, and the run's page, for the MR title and footer (prompt
 * variables) and the commit trailers (the run's environment, read by the
 * hook in commit-trailers.ts). The text rules are in @optio/shared
 * (work-traceability.ts); this file looks the people up. docs/prompts.md
 * ("Traceability") lists what ends up in the repository's history.
 *
 * Off unless the deployment names the repositories it is for:
 * OPTIO_WORK_TRACEABILITY_REPOS (Helm `tickets.traceability.repos`), a
 * comma-separated list of repository URLs, or `host/group/*` for every
 * repository under a group. Commits and MR text are public wherever the
 * repository is, so a deployment opts in only the repositories whose history
 * may name its people and its Optio address.
 *
 * Who asked: the person who made the work. Ticket work names nobody (Optio
 * does not know who reported the ticket, and the trigger's owner did not
 * ask). Their email is left out (no Co-authored-by) unless
 * OPTIO_WORK_TRACEABILITY_EMAIL=true (Helm `tickets.traceability.requesterEmail`).
 * The run's page is `<PUBLIC_URL>/work/<id>`, left out while PUBLIC_URL is
 * unset. OPTIO_COMMIT_TRAILERS=false (Helm `tickets.commitTrailers`) leaves
 * the commit trailers out; the MR title and footer stay.
 */
import { eq } from "drizzle-orm";
import {
  normalizeRepoUrl,
  commitTrailerEnv,
  commitTrailers,
  mrFooter,
  mrTitle,
  oneLine,
  traceabilityPromptVars,
  type WorkTrace,
} from "@optio/shared";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { logger } from "../logger.js";

export interface TraceableTask {
  id: string;
  title: string;
  repoUrl?: string | null;
  ticketSource?: string | null;
  ticketExternalId?: string | null;
  metadata?: unknown;
  createdBy?: string | null;
  ownerUserId?: string | null;
  ownerTeamId?: string | null;
}

/**
 * The repositories traceability is for (OPTIO_WORK_TRACEABILITY_REPOS),
 * normalized: a URL names one repository, a trailing `/*` every repository
 * under that path. Empty by default.
 */
function traceableRepos(env: NodeJS.ProcessEnv): string[] {
  return (env.OPTIO_WORK_TRACEABILITY_REPOS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) =>
      entry.endsWith("/*") ? `${normalizeRepoUrl(entry.slice(0, -2))}/*` : normalizeRepoUrl(entry),
    );
}

/** Whether runs on `repoUrl` say where their work came from (default: no repository). */
export function workTraceabilityEnabled(
  repoUrl: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!repoUrl) return false;
  const repo = normalizeRepoUrl(repoUrl).toLowerCase();
  return traceableRepos(env).some((entry) => {
    const e = entry.toLowerCase();
    return e.endsWith("/*") ? repo.startsWith(e.slice(0, -1)) : repo === e;
  });
}

/** Whether the requester's email goes into a Co-authored-by trailer (default: no). */
export function requesterEmailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OPTIO_WORK_TRACEABILITY_EMAIL ?? "").trim().toLowerCase() === "true";
}

/** Whether commits get trailers once traceability is on (OPTIO_COMMIT_TRAILERS, default on). */
function commitTrailersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OPTIO_COMMIT_TRAILERS ?? "").trim().toLowerCase() !== "false";
}

/** `<PUBLIC_URL>/work/<id>`, or null while PUBLIC_URL is unset. */
function runUrlOf(taskId: string): string | null {
  const base = process.env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  return base ? `${base}/work/${taskId}` : null;
}

function metaOf(task: TraceableTask): Record<string, unknown> {
  return task.metadata && typeof task.metadata === "object"
    ? (task.metadata as Record<string, unknown>)
    : {};
}

async function personOf(userId: string | null | undefined): Promise<WorkTrace["requester"]> {
  if (!userId) return null;
  const [u] = await db
    .select({ displayName: users.displayName, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) return null;
  return { name: u.displayName, email: requesterEmailEnabled() ? u.email : null };
}

/** Everything the MR and the commits say about this work. */
async function workTrace(task: TraceableTask): Promise<WorkTrace> {
  const meta = metaOf(task);
  const requester = task.ticketSource ? null : await personOf(task.createdBy ?? task.ownerUserId);
  const teamName: string | null = null;
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
  if (!workTraceabilityEnabled(task.repoUrl)) return { promptVars: {}, env: {} };
  try {
    const trace = await workTrace(task);
    const promptVars = traceabilityPromptVars(trace);
    if (!commitTrailersEnabled())
      return { promptVars: { ...promptVars, COMMIT_TRAILERS: "" }, env: {} };
    return { promptVars, env: commitTrailerEnv(trace) };
  } catch (err) {
    logger.warn({ err, taskId: task.id }, "Could not look up the work's requester");
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
  if (!workTraceabilityEnabled(task.repoUrl)) return "";
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
    logger.warn({ err, taskId: task.id }, "Could not look up the work's requester");
    return "";
  }
}
