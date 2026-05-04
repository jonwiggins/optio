import { describe, it, expect } from "vitest";
import {
  DEFAULT_PROMPT_TEMPLATE,
  renderPromptTemplate,
  renderTaskFile,
  TASK_FILE_PATH,
} from "./prompt-template.js";

describe("renderPromptTemplate", () => {
  it("replaces simple variables", () => {
    const result = renderPromptTemplate("Hello {{NAME}}, task {{ID}}", {
      NAME: "world",
      ID: "123",
    });
    expect(result).toBe("Hello world, task 123");
  });

  it("handles missing variables by replacing with empty string", () => {
    const result = renderPromptTemplate("Hello {{NAME}}", {});
    expect(result).toBe("Hello");
  });

  it("handles if/else blocks with truthy value", () => {
    const result = renderPromptTemplate("{{#if AUTO_MERGE}}merge it{{else}}review it{{/if}}", {
      AUTO_MERGE: "true",
    });
    expect(result).toBe("merge it");
  });

  it("handles if/else blocks with falsy value", () => {
    const result = renderPromptTemplate("{{#if AUTO_MERGE}}merge it{{else}}review it{{/if}}", {
      AUTO_MERGE: "false",
    });
    expect(result).toBe("review it");
  });

  it("handles if/else blocks with empty value", () => {
    const result = renderPromptTemplate("{{#if AUTO_MERGE}}merge it{{else}}review it{{/if}}", {
      AUTO_MERGE: "",
    });
    expect(result).toBe("review it");
  });

  it("handles if block without else", () => {
    const result = renderPromptTemplate("start {{#if SHOW}}visible{{/if}} end", { SHOW: "yes" });
    expect(result).toBe("start visible end");
  });

  it("handles if block without else when falsy", () => {
    const result = renderPromptTemplate("start {{#if SHOW}}visible{{/if}} end", { SHOW: "" });
    expect(result).toBe("start  end");
  });

  it("handles multiple variables and conditionals", () => {
    const template = `Task: {{TASK_TITLE}}
Branch: {{BRANCH_NAME}}
{{#if AUTO_MERGE}}Auto-merge enabled{{else}}Manual review{{/if}}`;
    const result = renderPromptTemplate(template, {
      TASK_TITLE: "Fix bug",
      BRANCH_NAME: "optio/task-123",
      AUTO_MERGE: "true",
    });
    expect(result).toContain("Fix bug");
    expect(result).toContain("optio/task-123");
    expect(result).toContain("Auto-merge enabled");
  });
});

describe("renderTaskFile", () => {
  it("renders a basic task file", () => {
    const result = renderTaskFile({
      taskTitle: "Fix the login bug",
      taskBody: "The login form doesn't validate email format.",
      taskId: "abc-123",
    });
    expect(result).toContain("# Fix the login bug");
    expect(result).toContain("The login form doesn't validate email format.");
    expect(result).toContain("abc-123");
  });

  it("includes ticket source when provided", () => {
    const result = renderTaskFile({
      taskTitle: "Fix bug",
      taskBody: "Description",
      taskId: "abc-123",
      ticketSource: "github",
      ticketUrl: "https://github.com/org/repo/issues/42",
    });
    expect(result).toContain("github");
    expect(result).toContain("https://github.com/org/repo/issues/42");
  });
});

describe("DEFAULT_PROMPT_TEMPLATE", () => {
  it("uses issue reference when ISSUE_NUMBER is provided", () => {
    const result = renderPromptTemplate(DEFAULT_PROMPT_TEMPLATE, {
      TASK_FILE: ".optio/task.md",
      BRANCH_NAME: "optio/task-abc",
      TASK_ID: "abc-123",
      TASK_TITLE: "Fix login bug",
      REPO_NAME: "org/repo",
      AUTO_MERGE: "false",
      ISSUE_NUMBER: "42",
    });
    expect(result).toContain("Closes #42");
    expect(result).not.toContain("Implements task");
  });

  it("falls back to task ID when ISSUE_NUMBER is not provided", () => {
    const result = renderPromptTemplate(DEFAULT_PROMPT_TEMPLATE, {
      TASK_FILE: ".optio/task.md",
      BRANCH_NAME: "optio/task-abc",
      TASK_ID: "abc-123",
      TASK_TITLE: "Fix login bug",
      REPO_NAME: "org/repo",
      AUTO_MERGE: "false",
      ISSUE_NUMBER: "",
    });
    expect(result).toContain("Implements task abc-123");
    expect(result).not.toContain("Closes #");
  });

  it("includes --draft flag when DRAFT_PR is true", () => {
    const result = renderPromptTemplate(DEFAULT_PROMPT_TEMPLATE, {
      TASK_FILE: ".optio/task.md",
      BRANCH_NAME: "optio/task-abc",
      TASK_ID: "abc-123",
      TASK_TITLE: "Fix login bug",
      REPO_NAME: "org/repo",
      AUTO_MERGE: "false",
      DRAFT_PR: "true",
      ISSUE_NUMBER: "",
    });
    expect(result).toContain("--draft");
    expect(result).toContain("opened as a draft");
  });

  it("does not include --draft flag when DRAFT_PR is false", () => {
    const result = renderPromptTemplate(DEFAULT_PROMPT_TEMPLATE, {
      TASK_FILE: ".optio/task.md",
      BRANCH_NAME: "optio/task-abc",
      TASK_ID: "abc-123",
      TASK_TITLE: "Fix login bug",
      REPO_NAME: "org/repo",
      AUTO_MERGE: "false",
      DRAFT_PR: "false",
      ISSUE_NUMBER: "",
    });
    expect(result).not.toContain("--draft");
    expect(result).not.toContain("opened as a draft");
  });
});

describe("PLANNING_MODE in DEFAULT_PROMPT_TEMPLATE", () => {
  it("includes planning mode instructions when PLANNING_MODE is truthy", () => {
    const result = renderPromptTemplate(DEFAULT_PROMPT_TEMPLATE, {
      TASK_FILE: ".optio/task.md",
      BRANCH_NAME: "optio/task-abc",
      TASK_ID: "abc-123",
      TASK_TITLE: "Fix login bug",
      REPO_NAME: "org/repo",
      AUTO_MERGE: "false",
      ISSUE_NUMBER: "",
      PLANNING_MODE: "true",
    });
    expect(result).toContain("PLANNING MODE");
    expect(result).toContain("DO NOT create/modify source files");
    expect(result).toContain("implementation plan");
  });

  it("does not include planning mode instructions when PLANNING_MODE is empty", () => {
    const result = renderPromptTemplate(DEFAULT_PROMPT_TEMPLATE, {
      TASK_FILE: ".optio/task.md",
      BRANCH_NAME: "optio/task-abc",
      TASK_ID: "abc-123",
      TASK_TITLE: "Fix login bug",
      REPO_NAME: "org/repo",
      AUTO_MERGE: "false",
      ISSUE_NUMBER: "",
      PLANNING_MODE: "",
    });
    expect(result).not.toContain("PLANNING MODE");
    expect(result).not.toContain("DO NOT create/modify source files");
  });

  it("does not include planning mode instructions when PLANNING_MODE is not set", () => {
    const result = renderPromptTemplate(DEFAULT_PROMPT_TEMPLATE, {
      TASK_FILE: ".optio/task.md",
      BRANCH_NAME: "optio/task-abc",
      TASK_ID: "abc-123",
      TASK_TITLE: "Fix login bug",
      REPO_NAME: "org/repo",
      AUTO_MERGE: "false",
      ISSUE_NUMBER: "",
    });
    expect(result).not.toContain("PLANNING MODE");
  });
});

describe("CodeCommit branch in DEFAULT_PROMPT_TEMPLATE", () => {
  it("uses aws codecommit create-pull-request when GIT_PLATFORM_CODECOMMIT is set", () => {
    const result = renderPromptTemplate(DEFAULT_PROMPT_TEMPLATE, {
      TASK_FILE: ".optio/task.md",
      BRANCH_NAME: "optio/task-abc",
      TASK_ID: "abc-123",
      TASK_TITLE: "Fix login bug",
      REPO_NAME: "MyRepo",
      CODECOMMIT_REPO: "MyRepo",
      BASE_BRANCH: "main",
      AUTO_MERGE: "false",
      ISSUE_NUMBER: "",
      GIT_PLATFORM_CODECOMMIT: "true",
    });
    expect(result).toContain("aws codecommit create-pull-request");
    expect(result).toContain("repositoryName=MyRepo");
    expect(result).toContain("sourceReference=optio/task-abc");
    expect(result).toContain("destinationReference=main");
    expect(result).not.toContain("gh pr create");
    expect(result).not.toContain("glab mr create");
  });

  it("falls back to gh when neither codecommit nor gitlab is set", () => {
    const result = renderPromptTemplate(DEFAULT_PROMPT_TEMPLATE, {
      TASK_FILE: ".optio/task.md",
      BRANCH_NAME: "optio/task-abc",
      TASK_ID: "abc-123",
      TASK_TITLE: "Fix login bug",
      REPO_NAME: "org/repo",
      AUTO_MERGE: "false",
      ISSUE_NUMBER: "",
    });
    expect(result).toContain("gh pr create");
    expect(result).not.toContain("aws codecommit");
    expect(result).not.toContain("glab mr create");
  });
});

describe("TASK_FILE_PATH", () => {
  it("is a relative path", () => {
    expect(TASK_FILE_PATH).not.toMatch(/^\//);
    expect(TASK_FILE_PATH).toContain(".optio/");
  });
});
