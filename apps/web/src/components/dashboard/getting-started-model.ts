/**
 * The Overview's getting-started checklist (docs/using-optio.md), shown while
 * a deployment admin has the getting-started guide on: what a new person
 * still has to do before Optio works for them, read from the state the API
 * already reports. It speaks of pull or merge requests by the repos'
 * platform. Pure: the component (getting-started.tsx) loads the sources and
 * renders what `buildChecklist` returns, so every state is tested here
 * without a page.
 */
import { isMergeRequest } from "@optio/shared";

/**
 * - `done`: nothing left to do.
 * - `todo`: the person's next step.
 * - `waiting`: on someone else (a workspace admin adds the repository).
 */
export type StepState = "done" | "todo" | "waiting";

type StepId = "sign-in" | "repo" | "first-task" | "first-review";

export interface ChecklistStep {
  id: StepId;
  title: string;
  detail: string;
  state: StepState;
  /** Where the step is done; null when there is nothing to open. */
  href: string | null;
  /** The link's words ("Add repo"); "Go" or "Open" when absent. */
  action?: string;
}

/** A task as the checklist names it. */
interface TaskRef {
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
  user: { id: string; email: string };
  repoCount: number | null;
  /** The workspace's repos' platforms (`github`, `gitlab`, …); absent or null: unknown. */
  repoPlatforms?: Array<string | null> | null;
  tasks: MyTasks | null;
}

export interface ChecklistContext {
  /** A workspace admin (adds repos). */
  isAdmin: boolean;
  /** A viewer: no work of their own, so no repository, task or review steps. */
  isViewer: boolean;
}

export interface Checklist {
  steps: ChecklistStep[];
  counted: number;
  done: number;
  /** Every step is done. */
  complete: boolean;
  /**
   * Complete, and it will stay so: safe to remember, so the Overview stops
   * asking (getting-started-store.ts). Not for a viewer (their list grows if
   * they become a member), nor when a request failed (a step was left out).
   */
  settled: boolean;
}

function signInStep(user: ChecklistSources["user"]): ChecklistStep {
  return {
    id: "sign-in",
    title: "Sign in",
    detail: `Signed in as ${user.email}.`,
    state: "done",
    href: null,
  };
}

/** How the checklist names a change request and a repo, by the repos' platform. */
interface Words {
  /** "pull request" or "merge request". */
  pr: string;
  /** "repository", or "GitLab project" where the repos are GitLab's. */
  repo: string;
}

function wordsFor(src: ChecklistSources): Words {
  const known = new Set((src.repoPlatforms ?? []).filter((p): p is string => !!p));
  // One platform for every repo decides; none or a mix: GitHub's words, as the app's.
  const platform = known.size === 1 ? [...known][0] : undefined;
  const repoIsGitLab = isMergeRequest(null, { platform });
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
        detail: `Add a ${words.repo} so Optio can clone it and run agents on it.`,
        state: "todo",
        href: "/repos/new",
        action: "Add repo",
      }
    : {
        id: "repo",
        title: "A repository to work on",
        detail: `No repositories here yet. A workspace admin adds each ${words.repo} under Repos.`,
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

/** The steps in order, and how far along the person is. */
export function buildChecklist(src: ChecklistSources, ctx: ChecklistContext): Checklist {
  const words = wordsFor(src);
  const steps: (ChecklistStep | null)[] = [signInStep(src.user)];
  if (!ctx.isViewer) {
    steps.push(
      repoStep(src.repoCount, ctx, words),
      firstTaskStep(src.tasks, words),
      firstReviewStep(src.tasks, words),
    );
  }
  const shown = steps.filter((s): s is ChecklistStep => s !== null);
  const done = shown.filter((s) => s.state === "done").length;
  const complete = done === shown.length;
  return {
    steps: shown,
    counted: shown.length,
    done,
    complete,
    settled: complete && !ctx.isViewer && src.repoCount !== null && src.tasks !== null,
  };
}

/** A task as `/api/tasks/search` returns it, as far as the checklist reads it. */
interface FoundTask {
  id: string;
  title?: string | null;
  prUrl?: string | null;
  prState?: string | null;
}

/** The person's Repo Tasks from `/api/tasks/search` answers: the first merged one with a PR. */
export function pickMyTasks(answers: {
  started: FoundTask[];
  waiting: FoundTask[];
  completed: FoundTask[];
}): MyTasks {
  const ref = (t: FoundTask | undefined) =>
    t ? { id: t.id, title: t.title ?? null, prUrl: t.prUrl ?? null } : null;
  return {
    started: ref(answers.started[0]),
    waiting: ref(answers.waiting[0]),
    // Completed with its pull request merged; one without a PR proves no review.
    merged: ref(answers.completed.find((t) => !!t.prUrl && t.prState === "merged")),
  };
}
