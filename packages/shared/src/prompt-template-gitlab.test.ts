import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * prompt-template.ts with OPTIO_GIT_PLATFORMS set to `gitPlatforms` (unset =
 * every platform; the prompts are chosen at load).
 */
async function promptsUnder(gitPlatforms?: string) {
  vi.resetModules();
  vi.stubEnv("OPTIO_GIT_PLATFORMS", gitPlatforms ?? "");
  return import("./prompt-template.js");
}

const CODING_VARS = {
  TASK_FILE: ".optio/task.md",
  BRANCH_NAME: "optio/task-1",
  TASK_ID: "1",
  TASK_TITLE: "Add a thing",
  BASE_BRANCH: "develop",
};

const REVIEW_VARS = {
  PR_NUMBER: "12",
  TASK_FILE: ".optio/review-context.md",
  REPO_NAME: "group/app",
  OUTPUT_PATH: ".optio/review-draft.json",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("a deployment that offers GitLab and not GitHub gets prompts that speak GitLab only", () => {
  it("is not the default: without OPTIO_GIT_PLATFORMS the prompts are upstream's", async () => {
    expect((await promptsUnder()).GITLAB_ONLY_PROMPTS).toBe(false);
    expect((await promptsUnder("github,gitlab")).GITLAB_ONLY_PROMPTS).toBe(false);
    expect((await promptsUnder("gitlab")).GITLAB_ONLY_PROMPTS).toBe(true);
  });

  it("opens a merge request with glab, whatever the repo's platform flag says", async () => {
    const m = await promptsUnder("gitlab");
    // No GIT_PLATFORM_GITLAB: a self-hosted GitLab whose URL says nothing.
    const out = m.renderPromptTemplate(m.DEFAULT_PROMPT_TEMPLATE, CODING_VARS);
    expect(out).toContain(
      "glab mr create --fill --yes --remove-source-branch --target-branch develop",
    );
    expect(out).toContain('glab mr update --title "Add a thing"');
    expect(out).toContain("Implements task 1");
    expect(out).not.toMatch(/\bgh\b/);
    expect(out).not.toContain("pull request");
    expect(out).not.toContain("codecommit");
    expect(out).not.toContain("--draft");
  });

  it("opens a draft MR when DRAFT_PR is set, and closes the issue it came from", async () => {
    const m = await promptsUnder("gitlab");
    const out = m.renderPromptTemplate(m.DEFAULT_PROMPT_TEMPLATE, {
      ...CODING_VARS,
      DRAFT_PR: "true",
      ISSUE_NUMBER: "7",
    });
    expect(out).toContain("--target-branch develop --draft");
    expect(out).toContain("Closes #7");
    expect(out).toContain("opened as a draft");
  });

  it("titles Jira work with its key and ends the description with the footer", async () => {
    const m = await promptsUnder("gitlab");
    const { traceabilityPromptVars } = await import("./work-traceability.js");
    const out = m.renderPromptTemplate(m.DEFAULT_PROMPT_TEMPLATE, {
      ...CODING_VARS,
      // The Jira key is the ticket's id, which upstream rendered as "Closes #PLAT-1".
      ISSUE_NUMBER: "PLAT-1",
      ...traceabilityPromptVars({
        title: 'Add a "health" endpoint',
        ticketSource: "jira",
        ticketKey: "PLAT-1",
        ticketUrl: "https://jira.example.test/browse/PLAT-1",
        requester: { name: "Ada Lovelace", email: "ada@example.test" },
        teamName: "Platform",
        runUrl: "https://optio.example.test/work/1",
      }),
    });
    expect(out).toContain('glab mr update --title "PLAT-1: Add a \\"health\\" endpoint"');
    expect(out).not.toContain("Closes #PLAT-1");
    expect(out).toContain("Jira: [PLAT-1](https://jira.example.test/browse/PLAT-1)");
    expect(out).toContain("Requested by: Ada Lovelace");
    expect(out).toContain("Optio run: https://optio.example.test/work/1\nOPTIO_PR_EOF");
    expect(out).toContain("Co-authored-by: Ada Lovelace <ada@example.test>");
    expect(out).toContain("Optio-Run: https://optio.example.test/work/1");
  });

  it("keeps the description as it was without the traceability variables", async () => {
    const m = await promptsUnder("gitlab");
    const out = m.renderPromptTemplate(m.DEFAULT_PROMPT_TEMPLATE, {
      ...CODING_VARS,
      ISSUE_NUMBER: "7",
    });
    expect(out).toContain("Closes #7\n\n## What changed");
    expect(out).toContain("<Describe how a reviewer can verify the changes>\nOPTIO_PR_EOF");
    expect(out).not.toContain("trailers");
  });

  it("reviews with glab mr approve / note, the discussion and the pipeline", async () => {
    const m = await promptsUnder("gitlab");
    const out = m.renderPromptTemplate(m.DEFAULT_REVIEW_PROMPT_TEMPLATE, {
      ...REVIEW_VARS,
      ...m.reviewDepthVars("thorough"),
    });
    expect(out).toContain("MR !12");
    expect(out).toContain("glab mr diff 12");
    expect(out).toContain("glab mr view 12 --comments");
    expect(out).toContain("glab ci status");
    expect(out).toContain("glab mr approve 12 || (glab mr revoke 12 && glab mr approve 12)");
    expect(out).toContain('glab mr note 12 --message "Your review summary"');
    expect(out).toContain("THOROUGH review");
    expect(out).not.toMatch(/\bgh\b/);
    expect(out).not.toContain("PR #");
  });

  it("runs the test command in a thorough review instead of reading the pipeline", async () => {
    const m = await promptsUnder("gitlab");
    const out = m.renderPromptTemplate(m.DEFAULT_REVIEW_PROMPT_TEMPLATE, {
      ...REVIEW_VARS,
      TEST_COMMAND: "pnpm test",
      ...m.reviewDepthVars("thorough"),
    });
    expect(out).toContain("pnpm test");
    expect(out).not.toContain("glab ci status");
  });

  it("keeps a light review to the diff: no tests, no discussion, top findings", async () => {
    const m = await promptsUnder("gitlab");
    for (const template of [
      m.DEFAULT_REVIEW_PROMPT_TEMPLATE,
      m.DEFAULT_PR_REVIEW_PROMPT_TEMPLATE,
    ]) {
      const out = m.renderPromptTemplate(template, {
        ...REVIEW_VARS,
        // The services never pass a test command to a light review; the prompt
        // holds even if a custom caller did.
        ...m.reviewDepthVars("light"),
      });
      expect(out).toContain("LIGHT review");
      expect(out).toContain("glab mr diff 12");
      expect(out).toMatch(/three\s+most\s+important\s+findings/);
      expect(out).not.toContain("--comments");
      expect(out).not.toContain("glab ci status");
      expect(out).not.toMatch(/\bgh\b/);
    }
  });

  it("drafts an external MR review to a file and never posts it", async () => {
    const m = await promptsUnder("gitlab");
    const out = m.renderPromptTemplate(m.DEFAULT_PR_REVIEW_PROMPT_TEMPLATE, {
      ...REVIEW_VARS,
      ...m.reviewDepthVars("thorough"),
    });
    expect(out).toContain("cat > .optio/review-draft.json");
    expect(out).toContain("Do NOT submit the review to GitLab");
    expect(out).toContain("glab ci status");
    expect(out).not.toMatch(/\bgh\b/);
  });
});

describe("every platform offered (the default) keeps upstream's prompts", () => {
  it("branches on the platform, GitHub by default", async () => {
    const m = await promptsUnder();
    expect(m.GITLAB_ONLY_PROMPTS).toBe(false);
    const github = m.renderPromptTemplate(m.DEFAULT_PROMPT_TEMPLATE, CODING_VARS);
    expect(github).toContain("gh pr create");
    const gitlab = m.renderPromptTemplate(m.DEFAULT_PROMPT_TEMPLATE, {
      ...CODING_VARS,
      GIT_PLATFORM_GITLAB: "true",
    });
    expect(gitlab).toContain("glab mr create");
    expect(gitlab).not.toContain("gh pr create");
  });

  it("adds the light-review note to both review prompts only for a light review", async () => {
    const m = await promptsUnder();
    for (const template of [
      m.DEFAULT_REVIEW_PROMPT_TEMPLATE,
      m.DEFAULT_PR_REVIEW_PROMPT_TEMPLATE,
    ]) {
      const light = m.renderPromptTemplate(template, {
        ...REVIEW_VARS,
        ...m.reviewDepthVars("light"),
      });
      expect(light).toContain("LIGHT review");
      expect(light).toContain("gh pr diff 12");
      const thorough = m.renderPromptTemplate(template, {
        ...REVIEW_VARS,
        ...m.reviewDepthVars("thorough"),
      });
      expect(thorough).not.toContain("LIGHT review");
    }
  });
});

describe("a GitLab repo gets GitLab's built-in prompts whatever the platforms", () => {
  for (const platforms of [undefined, "gitlab"]) {
    it(`opens a draft merge request on the base branch (${platforms ?? "every platform"})`, async () => {
      const m = await promptsUnder(platforms);
      const { task, review, prReview } = m.builtinPromptTemplates("gitlab");
      const out = m.renderPromptTemplate(task, {
        ...CODING_VARS,
        GIT_PLATFORM_GITLAB: "true",
        DRAFT_PR: "true",
      });
      expect(out).toContain("--target-branch develop --draft");
      expect(out).not.toContain("gh pr create");
      for (const template of [review, prReview]) {
        const text = m.renderPromptTemplate(template, {
          ...REVIEW_VARS,
          GIT_PLATFORM_GITLAB: "true",
        });
        expect(text).toContain("glab mr diff 12");
        expect(text).not.toContain("gh pr");
      }
    });
  }

  it("leaves a GitHub repo on the default prompts (every platform)", async () => {
    const m = await promptsUnder();
    const builtin = m.builtinPromptTemplates("github");
    expect(builtin.task).toBe(m.DEFAULT_PROMPT_TEMPLATE);
    expect(builtin.review).toBe(m.DEFAULT_REVIEW_PROMPT_TEMPLATE);
    expect(builtin.prReview).toBe(m.DEFAULT_PR_REVIEW_PROMPT_TEMPLATE);
    expect(m.builtinPromptTemplates(null).task).toBe(m.DEFAULT_PROMPT_TEMPLATE);
  });

  it("opens a draft from the default prompt's GitLab arm too (every platform)", async () => {
    const m = await promptsUnder();
    const draft = m.renderPromptTemplate(m.DEFAULT_PROMPT_TEMPLATE, {
      ...CODING_VARS,
      GIT_PLATFORM_GITLAB: "true",
      DRAFT_PR: "true",
    });
    expect(draft).toContain("--remove-source-branch --draft");
    const ready = m.renderPromptTemplate(m.DEFAULT_PROMPT_TEMPLATE, {
      ...CODING_VARS,
      GIT_PLATFORM_GITLAB: "true",
      DRAFT_PR: "false",
    });
    expect(ready).not.toContain("--draft");
  });
});

describe("review depth helpers", () => {
  it("sets REVIEW_LIGHT only for a light review", async () => {
    const m = await promptsUnder("gitlab");
    expect(m.reviewDepthVars("light")).toEqual({ REVIEW_DEPTH: "light", REVIEW_LIGHT: "true" });
    expect(m.reviewDepthVars("thorough")).toEqual({ REVIEW_DEPTH: "thorough", REVIEW_LIGHT: "" });
  });

  it("halves a light review's turns, never below one", async () => {
    const m = await promptsUnder("gitlab");
    expect(m.reviewMaxTurns("light", 30)).toBe(15);
    expect(m.reviewMaxTurns("light", 7)).toBe(3);
    expect(m.reviewMaxTurns("light", 1)).toBe(1);
    expect(m.reviewMaxTurns("thorough", 30)).toBe(30);
  });
});
