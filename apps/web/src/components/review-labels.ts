/**
 * The code-review settings' words (Settings → Agents → Code review, a
 * repo's automatic review), for GitHub's pull requests and GitLab's merge
 * requests alike.
 */

/** "Starts": when an automatic review begins. */
export const REVIEW_TRIGGER_LABEL = {
  on_ci_pass: "After CI passes",
  on_pr: "When the PR / MR opens",
  manual: "Manual only",
} as const;

/** The variables a review prompt can use, with what each holds. */
export const REVIEW_PROMPT_VARS: Array<[string, string]> = [
  ["PR_NUMBER", "PR / MR number"],
  ["TASK_FILE", "Path to the review context file"],
  ["REPO_NAME", "Repository name (e.g. owner/repo or group/project)"],
  ["TASK_TITLE", "Original task title"],
  ["TEST_COMMAND", "Test command (empty in a light review)"],
  ["REVIEW_DEPTH", "thorough or light; {{#if REVIEW_LIGHT}}…{{/if}} for light only"],
];

/** The workspace's test command, under the field. */
export const REVIEW_TEST_COMMAND_HELP =
  "A thorough review runs it on repos without their own. Leave empty if CI runs the tests — the reviewer checks CI status instead.";
