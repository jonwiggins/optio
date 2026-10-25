/**
 * The agent's instructions for work an @-mention starts or resumes
 * (docs/gitlab-bot.md). Pure. The comment is the person's request, quoted;
 * the merge request's or issue's text comes after it as context. A failed
 * pipeline's request takes the failed jobs' logs (resume-prompts.ts
 * `ciFailurePrompt`, the words an automatic CI resume uses).
 */
import { ciFailurePrompt } from "../resume-prompts.js";
import type { FailedJobs } from "../git-platform/gitlab-ci-logs.js";
import { GITLAB_WORDS, type ThreadWords } from "./words.js";

export interface MentionContext {
  author: string;
  /** `platform/hello-service`. */
  project: string;
  noteUrl: string | null;
  iid: number;
  title: string;
  description: string;
  url: string | null;
}

const MAX_DESCRIPTION = 6_000;

function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

function described(text: string): string {
  const t = text.trim();
  if (!t) return "(no description)";
  return t.length > MAX_DESCRIPTION ? `${t.slice(0, MAX_DESCRIPTION)}\n…(cut)` : t;
}

const where = (c: MentionContext) => (c.noteUrl ? ` (${c.noteUrl})` : "");

/** On a merge request Optio opened: the comment as the next instruction. */
export function resumePrompt(
  c: MentionContext,
  instruction: string,
  w: ThreadWords = GITLAB_WORDS,
): string {
  return [
    `@${c.author} asked for a change on your ${w.mr} ${w.ref(c.iid)} in a comment${where(c)}:`,
    "",
    quote(instruction),
    "",
    `Make the change on this ${w.mr}'s branch: edit the code, run the tests, commit and push. Don't open another ${w.mr}.`,
  ].join("\n");
}

/** `@bot fix pipeline` on a merge request Optio opened. */
export function fixPipelineResumePrompt(
  failure: FailedJobs,
  extra: string,
  w: ThreadWords = GITLAB_WORDS,
): string {
  const out = ciFailurePrompt(w.ciLabel, failure);
  return extra ? `${out}\n\nThe person who asked for the fix added:\n\n${quote(extra)}` : out;
}

/** On someone else's merge request: new work from its source branch, into it. */
export function mergeRequestTaskPrompt(
  c: MentionContext & { sourceBranch: string; targetBranch: string | null },
  instruction: string,
  failure?: FailedJobs | null,
  w: ThreadWords = GITLAB_WORDS,
): string {
  const parts: string[] = [];
  if (failure) {
    parts.push(
      `@${c.author} asked you to fix the failed ${w.pipeline} of ${w.mr} ${w.ref(c.iid)} "${c.title}" in ${c.project}${where(c)}.`,
      "",
      ciFailurePrompt(w.ciLabel, failure),
    );
    if (instruction) parts.push("", `They added:`, "", quote(instruction));
  } else {
    parts.push(
      `@${c.author} asked on ${w.mr} ${w.ref(c.iid)} "${c.title}" in ${c.project}${where(c)}:`,
      "",
      quote(instruction),
    );
  }
  parts.push(
    "",
    `That ${w.mr} merges \`${c.sourceBranch}\`${c.targetBranch ? ` into \`${c.targetBranch}\`` : ""}. Your branch starts from \`${c.sourceBranch}\`, and your ${w.mr} goes into \`${c.sourceBranch}\`, so its author can take your change into ${w.ref(c.iid)}. Mention ${w.ref(c.iid)} in your ${w.mr}'s description.`,
    "",
    `## The ${w.mr}'s description`,
    "",
    described(c.description),
  );
  return parts.join("\n");
}

/** On an issue: new work from the issue, its text and the comment. */
export function issueTaskPrompt(
  c: MentionContext,
  instruction: string,
  w: ThreadWords = GITLAB_WORDS,
): string {
  return [
    instruction
      ? `@${c.author} asked on issue #${c.iid} "${c.title}" in ${c.project}${where(c)}:`
      : `@${c.author} asked you to work on issue #${c.iid} "${c.title}" in ${c.project}${where(c)}.`,
    ...(instruction ? ["", quote(instruction)] : []),
    "",
    "## The issue",
    "",
    `# ${c.title}`,
    "",
    described(c.description),
    "",
    `Write \`Closes #${c.iid}\` in your ${w.mr}'s description, so the issue closes when it merges.`,
  ].join("\n");
}
