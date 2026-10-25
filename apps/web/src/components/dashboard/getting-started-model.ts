/**
 * The Overview's getting-started checklist (docs/using-optio.md), shown while
 * a deployment admin has the getting-started guide on: what a new person
 * still has to do before Optio works for them, read from the state the API
 * already reports. Steps for what this Optio doesn't use are left out (the
 * gateway token without a gateway, the team without teams), and it speaks of
 * pull or merge requests by the repos' platform. Pure: the component
 * (getting-started.tsx) loads the sources and renders what `buildChecklist`
 * returns, so every state is tested here without a page.
 */
import { chatFormatLabel, isMergeRequest, type DeploymentFeatures, type Team } from "@optio/shared";
import type { GatewayMe } from "@/lib/api-client";
import type { CredentialHealthRow } from "@/lib/credential-health-api";
import type { MyChannels } from "@/lib/notify-api";

/**
 * - `done`: nothing left to do.
 * - `todo`: the person's next step.
 * - `attention`: set up, but something is wrong (a refused token, no address).
 * - `waiting`: on someone else (an admin, a team's admins).
 * - `unavailable`: this Optio doesn't offer it; it never holds the list open.
 */
export type StepState = "done" | "todo" | "attention" | "waiting" | "unavailable";

export type StepId =
  | "sign-in"
  | "gateway-token"
  | "team"
  | "repo"
  | "first-task"
  | "first-review"
  | "notifications";

export interface ChecklistStep {
  id: StepId;
  title: string;
  detail: string;
  state: StepState;
  /** Where the step is done; null when there is nothing to open. */
  href: string | null;
  /** The link's words ("Add token"); the title is the link when absent. */
  action?: string;
  /** Doesn't count towards "all done" (joining a team). */
  optional?: boolean;
  /**
   * Done for now, but a check still to come may undo it (a token Optio
   * hasn't checked yet): a complete list with one isn't remembered.
   */
  provisional?: boolean;
}

/** A task as the checklist names it. */
export interface TaskRef {
  id: string;
  title: string | null;
  prUrl?: string | null;
}

/** The person's own Repo Tasks: one they started, one waiting for them, one merged. */
export interface MyTasks {
  started: TaskRef | null;
  waiting: TaskRef | null;
  merged: TaskRef | null;
}

/** Everything the checklist reads; `null` = that request failed (the step is left out or generic). */
export interface ChecklistSources {
  user: { id: string; email: string; provider?: string | null };
  gateway: GatewayMe | null;
  /** The person's own credential health rows (`GET /api/credential-health?mine=true`). */
  health: CredentialHealthRow[] | null;
  /** Null when the request failed, or when teams are off (not asked). */
  teams: Team[] | null;
  repoCount: number | null;
  /** The workspace's repos' platforms (`github`, `gitlab`, …); absent or null: unknown. */
  repoPlatforms?: Array<string | null> | null;
  tasks: MyTasks | null;
  channels: MyChannels | null;
}

export interface ChecklistContext {
  /** The restricted deployment: models only through the gateway (useFeatures().gatewayOnly). */
  gatewayOnly: boolean;
  /** The deployment's feature lists: without GitHub, merge requests (before a repo says). */
  features?: DeploymentFeatures;
  /** Teams are on (Settings → Access): the optional team step. */
  teams: boolean;
  /** A workspace admin (adds repos). */
  isAdmin: boolean;
  /** A viewer: no work of their own, so no token, task or review steps. */
  isViewer: boolean;
}

export interface Checklist {
  steps: ChecklistStep[];
  /** Steps that count: not optional, not unavailable here. */
  counted: number;
  done: number;
  /** Every counted step is done. */
  complete: boolean;
  /**
   * Complete, and it will stay so: safe to remember, so the Overview stops
   * asking (getting-started-store.ts). Not for a viewer (their list grows if
   * they become a member), when a request failed (a step was left out), or
   * with a provisional step.
   */
  settled: boolean;
}

const MY_TOKENS = "/settings#my-tokens";
const MY_NOTIFICATIONS = "/settings#my-notifications";

function signInStep(user: ChecklistSources["user"]): ChecklistStep {
  const how =
    user.provider === "ldap"
      ? "with your directory account"
      : user.provider === "oidc"
        ? "with single sign-on"
        : null;
  return {
    id: "sign-in",
    title: "Sign in",
    detail: `Signed in as ${user.email}${how ? ` ${how}` : ""}.`,
    state: "done",
    href: null,
  };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** "2026-11-01 00:00 UTC", as the API's reasons write it. */
function utc(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/**
 * A health row's error that the gateway's answer for the token can't overrule:
 * the check read the key's own info (a 200: a `spend` it reported) and
 * found it blocked or expired, which `/key/info` as `GET /api/gateway/me`
 * passes it on doesn't carry. A refusal (no info read) or a spent budget is
 * overruled by a 200 and a budget left now: the token was replaced, or the
 * budget reset, since that check.
 */
function errorKeyInfoCantOverrule(row: CredentialHealthRow): boolean {
  const spend = num(row.details.spend);
  if (spend === null) return false;
  const max = num(row.details.maxBudget);
  return max === null || spend < max;
}

/** The person's own token for the default gateway: added, and not refused. */
export function gatewayStep(
  me: GatewayMe | null,
  health: CredentialHealthRow[] | null,
  userId: string,
  gatewayOnly: boolean,
): ChecklistStep | null {
  const base = { id: "gateway-token" as const, href: MY_TOKENS };
  if (!me) {
    // Models come other ways under the default deployment: no step without a gateway.
    if (!gatewayOnly) return null;
    return {
      ...base,
      title: "Add your gateway token",
      detail: "Couldn't read your token. Settings → My tokens shows it.",
      state: "todo",
      action: "My tokens",
    };
  }
  const gw = me.gateway;
  if (!gw) {
    // Models come other ways under the default deployment: nothing to add then.
    if (!gatewayOnly) return null;
    return {
      ...base,
      title: "Model gateway",
      detail:
        "This Optio has no model gateway yet. An admin adds it under Settings → Model gateway; your token comes after.",
      state: "waiting",
      href: null,
    };
  }
  if (gw.tokenSource === "stored") {
    return {
      ...base,
      title: "Gateway token",
      detail: `${gw.name} uses one shared token for every run: nothing to add.`,
      state: "done",
      href: null,
    };
  }
  if (!me.hasToken) {
    return {
      ...base,
      title: "Add your gateway token",
      detail: `Every run of your own work reaches its model through ${gw.name} with your token. Get one or paste one under Settings → My tokens.`,
      state: "todo",
      action: "Add token",
    };
  }
  const row = (health ?? []).find((r) => r.key === `gateway:${gw.id}:user:${userId}`);
  // The gateway answered about the token just now. It answers a spent key too
  // (credential health and the run's pre-flight refuse that one), so its
  // budget is read here as theirs is.
  const info = me.keyInfo;
  if (info && info.maxBudget !== null && info.spend >= info.maxBudget) {
    const spent = `$${info.spend.toFixed(2)} of $${info.maxBudget.toFixed(2)} spent`;
    return {
      ...base,
      title: "Your gateway token is over its budget",
      detail: info.budgetResetAt
        ? `${gw.name} refuses it until its budget resets on ${utc(info.budgetResetAt)} (${spent}). Runs of your own work fail until then.`
        : `${gw.name} refuses it until whoever set its budget raises it (${spent}). Runs of your own work fail until then.`,
      state: "attention",
      action: "My tokens",
    };
  }
  if (row?.status === "error" && (!info || errorKeyInfoCantOverrule(row))) {
    const why = row.reason ?? `${gw.name} refused it at the last check.`;
    return {
      ...base,
      title: "Your gateway token is refused",
      detail: info
        ? `${why}${/[.!?]$/.test(why) ? "" : "."} Replaced it since? Check my tokens under Settings → My tokens checks it again.`
        : why,
      state: "attention",
      action: "Fix it",
    };
  }
  if (info) {
    return {
      ...base,
      title: "Gateway token",
      detail: `Stored, and ${gw.name} accepts it.`,
      state: "done",
    };
  }
  // A check that found it fine (or only near its budget or expiry) is final;
  // none yet, or one that couldn't reach the gateway, is done for now only.
  const checked = row?.status === "ok" || row?.status === "warning";
  return {
    ...base,
    title: "Gateway token",
    detail: row?.reason
      ? `Stored. ${row.reason}`
      : row
        ? "Stored, and it passed the last check."
        : "Stored. Optio checks it within 15 minutes; Check my tokens under Settings → My tokens checks it now.",
    state: "done",
    ...(checked ? {} : { provisional: true }),
  };
}

function teamStep(teams: Team[] | null): ChecklistStep | null {
  if (!teams) return null;
  const base = { id: "team" as const, href: "/teams", optional: true };
  const mine = teams.filter((t) => t.myStatus === "active");
  if (mine.length > 0) {
    return {
      ...base,
      title: "Join your team",
      detail: `You're in ${mine.map((t) => t.name).join(", ")}.`,
      state: "done",
    };
  }
  const asked = teams.filter((t) => t.myStatus === "requested");
  if (asked.length > 0) {
    return {
      ...base,
      title: "Join your team",
      detail: `Your request to join ${asked.map((t) => t.name).join(", ")} waits for its admins.`,
      state: "waiting",
    };
  }
  return {
    ...base,
    title: "Join your team",
    detail:
      teams.length === 0
        ? "Optional. No teams here yet: create one on the Teams page if your group works together."
        : "Optional. A team shares its work, secrets and ticket providers; join yours on the Teams page.",
    state: "todo",
    action: "Teams",
  };
}

/** How the checklist names a change request and a repo, by the repos' platform. */
interface Words {
  /** "pull request" or "merge request". */
  pr: string;
  /** "repository", or "GitLab project" where the repos are GitLab's. */
  repo: string;
}

function wordsFor(src: ChecklistSources, ctx: ChecklistContext): Words {
  const known = new Set((src.repoPlatforms ?? []).filter((p): p is string => !!p));
  // One platform for every repo decides; none or a mix: the feature lists do.
  const platform = known.size === 1 ? [...known][0] : null;
  const repoIsGitLab = isMergeRequest(null, { platform, features: ctx.features });
  // A task's own change request says best what it is.
  const prUrl = src.tasks?.waiting?.prUrl ?? src.tasks?.merged?.prUrl ?? null;
  const mr = prUrl ? isMergeRequest(prUrl) : repoIsGitLab;
  return {
    pr: mr ? "merge request" : "pull request",
    repo: repoIsGitLab ? "GitLab project" : "repository",
  };
}

function repoStep(
  repoCount: number | null,
  ctx: ChecklistContext,
  words: Words,
): ChecklistStep | null {
  if (repoCount == null) return null;
  const what = words.repo;
  if (repoCount > 0) {
    return {
      id: "repo",
      title: "A repository to work on",
      detail: `${repoCount} ${repoCount === 1 ? "repository" : "repositories"} in this workspace.`,
      state: "done",
      href: "/repos",
    };
  }
  return ctx.isAdmin
    ? {
        id: "repo",
        title: "Add a repository",
        detail: `Add a ${what} so Optio can clone it and run agents on it.`,
        state: "todo",
        href: "/repos/new",
        action: "Add repo",
      }
    : {
        id: "repo",
        title: "A repository to work on",
        detail: `No repositories here yet. A workspace admin adds each ${what} under Repos.`,
        state: "waiting",
        href: null,
      };
}

function taskName(t: TaskRef): string {
  return t.title?.trim() ? `"${t.title.trim()}"` : "Your task";
}

function firstTaskStep(tasks: MyTasks | null, words: Words): ChecklistStep {
  if (tasks?.started) {
    return {
      id: "first-task",
      title: "Start your first task",
      detail: `${taskName(tasks.started)} is yours.`,
      state: "done",
      href: `/work/${tasks.started.id}`,
    };
  }
  return {
    id: "first-task",
    title: "Start your first task",
    detail: `Describe the change in New work: an agent works on a branch and opens a ${words.pr}.`,
    state: "todo",
    href: "/work/new",
    action: "New work",
  };
}

function firstReviewStep(tasks: MyTasks | null, words: Words): ChecklistStep {
  const pr = words.pr;
  const title = `Review your first ${pr}`;
  if (tasks?.merged) {
    return {
      id: "first-review",
      title,
      detail: `${taskName(tasks.merged)} was merged.`,
      state: "done",
      href: `/work/${tasks.merged.id}`,
    };
  }
  if (tasks?.waiting) {
    return {
      id: "first-review",
      title: `Review your ${pr}`,
      detail: `${taskName(tasks.waiting)} is waiting for you: review the ${pr}, then merge it or ask for changes.`,
      state: "todo",
      href: `/work/${tasks.waiting.id}`,
      action: "Open",
    };
  }
  return {
    id: "first-review",
    title,
    detail: `When your task opens its ${pr}, review it and merge it, or tick "Merge it for me when it's ready" in New work.`,
    state: "todo",
    href: null,
  };
}

function notificationsStep(channels: MyChannels | null): ChecklistStep | null {
  if (!channels) return null;
  const base = { id: "notifications" as const, href: MY_NOTIFICATIONS };
  // Your own chat hook reaches you too, with or without email (docs/notifications.md).
  const hook = channels.chat?.hook;
  const chatOn = !!hook?.enabled && Object.values(channels.choices.chat ?? {}).some(Boolean);
  const emailOn =
    channels.email.available &&
    !!channels.email.address &&
    Object.values(channels.choices.email).some(Boolean);
  if (chatOn) {
    const chat = chatFormatLabel(hook.format);
    return {
      ...base,
      title: "Notifications",
      detail: emailOn
        ? `Optio emails ${channels.email.address} and posts to your chat hook when your work needs you.`
        : `Optio posts to your chat hook when your work needs you. Choose the events under Settings → Notifications.`,
      state: "done",
    };
  }
  if (!channels.email.available) {
    return {
      ...base,
      title: "Notifications",
      detail:
        "Email isn't set up on this Optio yet (an admin sets it under Settings → Notifications). You can add your own chat hook there; until then, what needs you shows on the Overview.",
      state: "unavailable",
    };
  }
  if (!channels.email.address) {
    return {
      ...base,
      title: "Notifications",
      detail:
        "Your account has no email address, so Optio can't email you. Ask an admin to check the email your sign-in gives Optio.",
      state: "attention",
    };
  }
  const anyOn = Object.values(channels.choices.email).some(Boolean);
  if (!anyOn) {
    return {
      ...base,
      title: "Choose what reaches you",
      detail: "Every email is off: Optio won't tell you when your work needs you.",
      state: "todo",
      action: "Notifications",
    };
  }
  return {
    ...base,
    title: "Notifications",
    detail: `Optio emails ${channels.email.address} when your work needs you. Choose the events under Settings → Notifications.`,
    state: "done",
  };
}

/** The steps in order, and how far along the person is. */
export function buildChecklist(src: ChecklistSources, ctx: ChecklistContext): Checklist {
  const words = wordsFor(src, ctx);
  const steps: (ChecklistStep | null)[] = [signInStep(src.user)];
  if (!ctx.isViewer) {
    steps.push(gatewayStep(src.gateway, src.health, src.user.id, ctx.gatewayOnly));
  }
  if (ctx.teams) steps.push(teamStep(src.teams));
  if (!ctx.isViewer) {
    steps.push(
      repoStep(src.repoCount, ctx, words),
      firstTaskStep(src.tasks, words),
      firstReviewStep(src.tasks, words),
    );
  }
  steps.push(notificationsStep(src.channels));
  const shown = steps.filter((s): s is ChecklistStep => s !== null);
  const counting = shown.filter((s) => !s.optional && s.state !== "unavailable");
  const done = counting.filter((s) => s.state === "done").length;
  const complete = done === counting.length;
  // Teams off: not asked, so not a request that failed.
  const read = ctx.isViewer
    ? []
    : [
        src.gateway,
        src.health,
        ...(ctx.teams ? [src.teams] : []),
        src.repoCount,
        src.tasks,
        src.channels,
      ];
  return {
    steps: shown,
    counted: counting.length,
    done,
    complete,
    settled:
      complete &&
      !ctx.isViewer &&
      read.every((source) => source !== null) &&
      !shown.some((s) => s.provisional),
  };
}

/** The person's Repo Tasks from `/api/tasks/search` answers: the first merged one with a PR. */
export function pickMyTasks(answers: {
  started: Array<{ id: string; title?: string | null }>;
  waiting: Array<{ id: string; title?: string | null; prUrl?: string | null }>;
  completed: Array<{ id: string; title?: string | null; prUrl?: string | null }>;
}): MyTasks {
  const ref = (t: { id: string; title?: string | null; prUrl?: string | null } | undefined) =>
    t ? { id: t.id, title: t.title ?? null, prUrl: t.prUrl ?? null } : null;
  return {
    started: ref(answers.started[0]),
    waiting: ref(answers.waiting[0]),
    // A task completes when its merge request merges; one without a PR proves no review.
    merged: ref(answers.completed.find((t) => !!t.prUrl)),
  };
}
