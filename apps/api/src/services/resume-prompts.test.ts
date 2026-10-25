import { describe, expect, it } from "vitest";
import { ciFailurePrompt, failedJobNames, rebaseTarget } from "./resume-prompts.js";
import type { FailedJobs } from "./git-platform/gitlab-ci-logs.js";

describe("rebaseTarget", () => {
  it("names the MR's own target branch", () => {
    expect(rebaseTarget("master")).toBe("origin/master");
    expect(rebaseTarget("release/1.2")).toBe("origin/release/1.2");
    expect(rebaseTarget("develop")).toBe("origin/develop");
  });

  it("quotes a branch name the shell would read", () => {
    expect(rebaseTarget("feat;rm -rf x")).toBe("'origin/feat;rm -rf x'");
    expect(rebaseTarget("a$(id)")).toBe("'origin/a$(id)'");
  });
});

const failure: FailedJobs = {
  pipelineId: 77,
  pipelineUrl: "https://gitlab.example.com/p/-/pipelines/77",
  jobs: [
    {
      id: 2,
      name: "unit",
      stage: "test",
      webUrl: "https://gitlab.example.com/p/-/jobs/2",
      tail: "E2E_FAIL_MARKER\nexit 1",
    },
    { id: 3, name: "build", stage: "build", tail: "" },
  ],
  more: [{ name: "docs", stage: "deploy" }],
};

describe("ciFailurePrompt", () => {
  const prompt = ciFailurePrompt("MR", failure);

  it("names the failed jobs on its first line (the task page shows it)", () => {
    const first = prompt.split("\n")[0];
    expect(first).toBe(
      "The pipeline failed on your MR in: unit (test), build (build), docs (deploy).",
    );
    expect(first.length).toBeLessThanOrEqual(200);
  });

  it("carries each job's log tail in a fence", () => {
    expect(prompt).toContain('### Job "unit" (stage test)');
    expect(prompt).toContain("https://gitlab.example.com/p/-/jobs/2");
    expect(prompt).toContain("```text\nE2E_FAIL_MARKER\nexit 1\n```");
    expect(prompt).toContain('### Job "build" (stage build)\n(its log could not be read');
    expect(prompt).toContain("Also failed (logs not included): docs.");
    expect(prompt).toContain("Pipeline: https://gitlab.example.com/p/-/pipelines/77");
    expect(prompt).toContain("glab ci trace");
  });

  it("uses a fence the log can't close", () => {
    const p = ciFailurePrompt("MR", {
      pipelineId: 1,
      jobs: [{ id: 1, name: "md", stage: "", tail: "```\nnot the end\n```" }],
      more: [],
    });
    expect(p).toContain("````text\n```\nnot the end\n```\n````");
    expect(p).toContain('### Job "md"\n');
  });
});

describe("ciFailurePrompt for a PR (GitHub Actions)", () => {
  const prompt = ciFailurePrompt("PR", {
    pipelineId: 10,
    pipelineUrl: "https://github.com/acme/app/actions/runs/10",
    jobs: [
      { id: 100, name: "unit", stage: "CI", tail: "FAIL_MARKER" },
      { id: 101, name: "lint", stage: "CI", tail: "" },
    ],
    more: [],
  });

  it("speaks of checks and gh, not of a pipeline and glab", () => {
    expect(prompt.split("\n")[0]).toBe("CI checks failed on your PR in: unit (CI), lint (CI).");
    expect(prompt).toContain("gh run view <run-id> --log-failed");
    expect(prompt).toContain("Workflow run: https://github.com/acme/app/actions/runs/10");
    expect(prompt).toContain('### Job "unit" (workflow CI)');
    expect(prompt).toContain("gh run view --job 101 --log");
    expect(prompt).not.toMatch(/glab|Pipeline:/);
  });
});

describe("failedJobNames", () => {
  it("cuts a long list near 150 characters", () => {
    const many: FailedJobs = {
      pipelineId: 1,
      jobs: [],
      more: Array.from({ length: 30 }, (_, i) => ({ name: `integration-suite-${i}`, stage: "" })),
    };
    const line = failedJobNames(many);
    expect(line.length).toBeLessThanOrEqual(170);
    expect(line).toMatch(/, and \d+ more$/);
  });

  it("cuts one very long name", () => {
    const line = failedJobNames({
      pipelineId: 1,
      jobs: [],
      more: [{ name: "x".repeat(300), stage: "" }],
    });
    expect(line).toHaveLength(148);
    expect(line.endsWith("…")).toBe(true);
  });
});
