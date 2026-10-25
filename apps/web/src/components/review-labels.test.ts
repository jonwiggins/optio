import { describe, expect, it } from "vitest";
import {
  REVIEW_PROMPT_VARS,
  REVIEW_TEST_COMMAND_HELP,
  REVIEW_TRIGGER_LABEL,
} from "./review-labels";

// Settings → Agents → Code review speaks of GitHub's pull requests and
// GitLab's merge requests alike.
describe("the code-review settings' words", () => {
  it("name the change request neutrally", () => {
    expect(REVIEW_TRIGGER_LABEL).toEqual({
      on_ci_pass: "After CI passes",
      on_pr: "When the PR / MR opens",
      manual: "Manual only",
    });
    const vars = Object.fromEntries(REVIEW_PROMPT_VARS);
    expect(vars.PR_NUMBER).toBe("PR / MR number");
    expect(vars.REPO_NAME).toBe("Repository name (e.g. owner/repo or group/project)");
    expect(REVIEW_TEST_COMMAND_HELP).toContain("Leave empty if CI runs the tests");
  });

  it("name no single platform", () => {
    const words = [
      ...Object.values(REVIEW_TRIGGER_LABEL),
      ...REVIEW_PROMPT_VARS.map(([, what]) => what),
      REVIEW_TEST_COMMAND_HELP,
    ].join("\n");
    expect(words).not.toMatch(/GitHub|GitLab|merge request|pull request|IID|pipeline/i);
  });

  it("keep the existing prompt variables, plus the review depth", () => {
    expect(REVIEW_PROMPT_VARS.map(([name]) => name)).toEqual([
      "PR_NUMBER",
      "TASK_FILE",
      "REPO_NAME",
      "TASK_TITLE",
      "TEST_COMMAND",
      "REVIEW_DEPTH",
    ]);
  });
});
