import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A scheduled task that starts from a prompt written for every platform (the
 * starter prompts' `{{#if GIT_PLATFORM_GITLAB}}…{{else}}…{{/if}}` arms) gets
 * its repo's arm; any other prompt renders as before, without a repo lookup.
 */

vi.mock("../db/client.js", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock("../db/schema.js", () => ({
  workDefinitions: { workspaceId: "work_definitions.workspace_id" },
  workflowTriggers: { id: "workflow_triggers.id" },
  promptTemplates: {},
  repos: {},
}));
vi.mock("./work-definition-service.js", () => ({
  getDefinition: vi.fn(),
  listDefinitions: vi.fn(),
  createDefinition: vi.fn(),
  updateDefinition: vi.fn(),
  deleteDefinition: vi.fn(),
}));
vi.mock("./task-service.js", () => ({ createTask: vi.fn(), transitionTask: vi.fn() }));
vi.mock("./prompt-template-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prompt-template-service.js")>()),
  getPromptTemplateById: vi.fn(),
}));
vi.mock("./repo-service.js", () => ({
  getRepoByUrl: vi.fn().mockResolvedValue(null),
  repoDefaultBranch: vi.fn().mockResolvedValue("main"),
}));
vi.mock("../workers/task-worker.js", () => ({ taskQueue: { add: vi.fn() } }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import * as taskService from "./task-service.js";
import { getRepoByUrl } from "./repo-service.js";
import { getDefinition } from "./work-definition-service.js";
import { getPromptTemplateById } from "./prompt-template-service.js";
import { instantiateTask } from "./task-config-service.js";

const ARMS =
  "Read {{#if GIT_PLATFORM_GITLAB}}merge request !{{mr}} with glab{{else}}pull request #{{mr}} with gh{{/if}}.";

function config(repoUrl: string) {
  return {
    id: "cfg-1",
    kind: "repo-blueprint",
    name: "Review",
    runTitle: "Review",
    prompt: "",
    promptTemplateId: "tpl-1",
    repoUrl,
    repoBranch: "main",
    agentType: null,
    maxRetries: 0,
    priority: 100,
    enabled: true,
    createdBy: null,
    workspaceId: "ws-1",
  };
}

async function renderedFor(repoUrl: string, template: string, params = { mr: "7" }) {
  vi.mocked(getDefinition).mockResolvedValue(config(repoUrl) as any);
  vi.mocked(getPromptTemplateById).mockResolvedValue({ id: "tpl-1", template } as any);
  await instantiateTask("cfg-1", { params });
  return vi.mocked(taskService.createTask).mock.calls.at(-1)![0].prompt;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(taskService.createTask).mockResolvedValue({ id: "t1", state: "queued" } as any);
});

describe("instantiateTask with a prompt written for every platform", () => {
  it("gives a GitHub repo the GitHub arm", async () => {
    expect(await renderedFor("https://github.com/o/r", ARMS)).toBe("Read pull request #7 with gh.");
  });

  it("gives a GitLab repo the GitLab arm", async () => {
    expect(await renderedFor("https://gitlab.com/g/r", ARMS)).toBe(
      "Read merge request !7 with glab.",
    );
  });

  it("knows a self-managed GitLab by the repo Optio recorded", async () => {
    vi.mocked(getRepoByUrl).mockResolvedValue({ gitPlatform: "gitlab" } as any);
    expect(await renderedFor("https://code.example.test/g/r", ARMS)).toBe(
      "Read merge request !7 with glab.",
    );
  });

  it("lets a trigger's own param of the same name win", async () => {
    expect(
      await renderedFor("https://github.com/o/r", ARMS, {
        mr: "7",
        GIT_PLATFORM_GITLAB: "true",
      } as any),
    ).toBe("Read merge request !7 with glab.");
  });

  it("renders any other prompt as before, without looking the repo up", async () => {
    expect(await renderedFor("https://github.com/o/r", "Fix {{mr}}{{#if x}} now{{/if}}")).toBe(
      "Fix 7",
    );
    expect(getRepoByUrl).not.toHaveBeenCalled();
  });
});
