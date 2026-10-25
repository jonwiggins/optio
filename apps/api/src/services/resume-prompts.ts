import { shellQuote } from "@optio/shared";
import type { FailedJobs } from "./git-platform/gitlab-ci-logs.js";

/**
 * The words of an automatic (or manual) resume that the fork changed — pure,
 * so the restart path (task-control-service.ts) can use them without the
 * loading side (resume-facts.ts).
 */

/** `origin/<branch>` as the agent types it, quoted when the name needs it. */
export function rebaseTarget(branch: string): string {
  const ref = `origin/${branch}`;
  return /^[A-Za-z0-9._/-]+$/.test(ref) ? ref : shellQuote(ref);
}

/** The jobs' names for one line: `unit (test), lint (test)`, cut near 150 characters. */
export function failedJobNames(failure: FailedJobs): string {
  const all = [...failure.jobs, ...failure.more].map((j) =>
    j.stage ? `${j.name} (${j.stage})` : j.name,
  );
  let line = "";
  for (const [i, name] of all.entries()) {
    const next = line ? `${line}, ${name}` : name;
    if (next.length > 150) {
      const rest = all.length - i;
      return line ? `${line}, and ${rest} more` : `${name.slice(0, 147)}…`;
    }
    line = next;
  }
  return line;
}

/** A fence longer than any run of backticks in `text`. */
function fenceFor(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  return "`".repeat(longest + 1);
}

/**
 * The prompt for a failed pipeline, with its jobs' logs. The first line names
 * the jobs: it is also the needs-attention event's message on the task page.
 * An MR's (GitLab) points at `glab`, a PR's (GitHub Actions) at `gh`.
 */
export function ciFailurePrompt(prLabel: string, failure: FailedJobs): string {
  const gitlab = prLabel === "MR";
  const out = gitlab
    ? [
        `The pipeline failed on your ${prLabel} in: ${failedJobNames(failure)}.`,
        "",
        `The end of each failed job's log is below (secrets masked). Find the cause, fix it — run the failing command yourself where you can — and push the fix. \`glab ci view\` and \`glab ci trace <job>\` show the whole pipeline and log.`,
      ]
    : [
        `CI checks failed on your ${prLabel} in: ${failedJobNames(failure)}.`,
        "",
        `The end of each failed job's log is below (secrets masked). Find the cause, fix it — run the failing command yourself where you can — and push the fix. \`gh pr checks\` and \`gh run view <run-id> --log-failed\` show every check and the whole log.`,
      ];
  if (failure.pipelineUrl) {
    out.push("", `${gitlab ? "Pipeline" : "Workflow run"}: ${failure.pipelineUrl}`);
  }
  for (const job of failure.jobs) {
    const where = job.stage ? ` (${gitlab ? "stage" : "workflow"} ${job.stage})` : "";
    out.push("", `### Job "${job.name}"${where}`);
    if (job.webUrl) out.push(job.webUrl);
    if (job.tail) {
      const fence = fenceFor(job.tail);
      out.push(`${fence}text`, job.tail, fence);
    } else {
      out.push(
        gitlab
          ? "(its log could not be read — use `glab ci trace` to see it)"
          : `(its log could not be read — use \`gh run view --job ${job.id} --log\` to see it)`,
      );
    }
  }
  if (failure.more.length > 0) {
    out.push("", `Also failed (logs not included): ${failure.more.map((j) => j.name).join(", ")}.`);
  }
  return out.join("\n");
}
