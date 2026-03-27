import { describe, it, expect } from "vitest";
import {
  shouldNotifySlack,
  isNotifiableState,
  buildSlackMessage,
  NOTIFIABLE_STATES,
} from "./slack-service.js";
import type { RepoRecord } from "./repo-service.js";

function makeRepoConfig(overrides: Partial<RepoRecord> = {}): RepoRecord {
  return {
    id: "repo-1",
    repoUrl: "https://github.com/test/repo",
    workspaceId: null,
    fullName: "test/repo",
    defaultBranch: "main",
    isPrivate: false,
    imagePreset: "node",
    extraPackages: null,
    setupCommands: null,
    customDockerfile: null,
    autoMerge: false,
    promptTemplateOverride: null,
    claudeModel: "opus",
    claudeContextWindow: "1m",
    claudeThinking: true,
    claudeEffort: "high",
    maxTurnsCoding: null,
    maxTurnsReview: null,
    autoResume: false,
    maxConcurrentTasks: 2,
    maxPodInstances: 1,
    maxAgentsPerPod: 2,
    reviewEnabled: false,
    reviewTrigger: "on_ci_pass",
    reviewPromptTemplate: null,
    testCommand: null,
    reviewModel: "sonnet",
    maxAutoResumes: null,
    slackWebhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
    slackChannel: null,
    slackNotifyOn: null,
    slackEnabled: true,
    networkPolicy: "unrestricted",
    secretProxy: false,
    offPeakOnly: false,
    cpuRequest: null,
    cpuLimit: null,
    memoryRequest: null,
    memoryLimit: null,
    dockerInDocker: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("isNotifiableState", () => {
  it("returns true for notifiable states", () => {
    expect(isNotifiableState("completed")).toBe(true);
    expect(isNotifiableState("failed")).toBe(true);
    expect(isNotifiableState("needs_attention")).toBe(true);
    expect(isNotifiableState("pr_opened")).toBe(true);
  });

  it("returns false for non-notifiable states", () => {
    expect(isNotifiableState("pending")).toBe(false);
    expect(isNotifiableState("queued")).toBe(false);
    expect(isNotifiableState("provisioning")).toBe(false);
    expect(isNotifiableState("running")).toBe(false);
    expect(isNotifiableState("cancelled")).toBe(false);
  });
});

describe("shouldNotifySlack", () => {
  it("returns true when Slack is enabled and state is notifiable", () => {
    const repo = makeRepoConfig();
    expect(shouldNotifySlack("completed", repo)).toBe(true);
    expect(shouldNotifySlack("failed", repo)).toBe(true);
    expect(shouldNotifySlack("pr_opened", repo)).toBe(true);
    expect(shouldNotifySlack("needs_attention", repo)).toBe(true);
  });

  it("returns false when Slack is disabled", () => {
    const repo = makeRepoConfig({ slackEnabled: false });
    expect(shouldNotifySlack("completed", repo)).toBe(false);
  });

  it("returns false when no webhook URL", () => {
    const repo = makeRepoConfig({ slackWebhookUrl: null });
    expect(shouldNotifySlack("completed", repo)).toBe(false);
  });

  it("returns false for non-notifiable states", () => {
    const repo = makeRepoConfig();
    expect(shouldNotifySlack("running", repo)).toBe(false);
    expect(shouldNotifySlack("queued", repo)).toBe(false);
  });

  it("returns false when repo config is null", () => {
    expect(shouldNotifySlack("completed", null)).toBe(false);
  });

  it("respects slackNotifyOn filter", () => {
    const repo = makeRepoConfig({ slackNotifyOn: ["failed", "needs_attention"] });
    expect(shouldNotifySlack("failed", repo)).toBe(true);
    expect(shouldNotifySlack("needs_attention", repo)).toBe(true);
    expect(shouldNotifySlack("completed", repo)).toBe(false);
    expect(shouldNotifySlack("pr_opened", repo)).toBe(false);
  });

  it("notifies on all notifiable states when slackNotifyOn is empty", () => {
    const repo = makeRepoConfig({ slackNotifyOn: [] });
    for (const state of NOTIFIABLE_STATES) {
      expect(shouldNotifySlack(state, repo)).toBe(true);
    }
  });
});

describe("buildSlackMessage", () => {
  const baseTask = {
    id: "task-123",
    title: "Fix the broken thing",
    repoUrl: "https://github.com/acme/widget",
    state: "completed" as any,
    prUrl: "https://github.com/acme/widget/pull/42",
    costUsd: "1.23",
    errorMessage: null,
  };

  it("includes task title and repo name", () => {
    const msg = buildSlackMessage(baseTask, "completed");
    expect(msg.text).toContain("Fix the broken thing");
    expect(msg.text).toContain("acme/widget");
  });

  it("includes PR link when present", () => {
    const msg = buildSlackMessage(baseTask, "pr_opened");
    const fieldsBlock = msg.blocks[1] as { fields: { text: string }[] };
    const prField = fieldsBlock.fields.find((f) => f.text.includes("View PR"));
    expect(prField).toBeDefined();
    expect(prField!.text).toContain("pull/42");
  });

  it("includes cost when present", () => {
    const msg = buildSlackMessage(baseTask, "completed");
    const fieldsBlock = msg.blocks[1] as { fields: { text: string }[] };
    const costField = fieldsBlock.fields.find((f) => f.text.includes("Cost"));
    expect(costField).toBeDefined();
    expect(costField!.text).toContain("$1.23");
  });

  it("includes error message for failed tasks", () => {
    const failedTask = { ...baseTask, state: "failed" as any, errorMessage: "Out of memory" };
    const msg = buildSlackMessage(failedTask, "failed");
    const errorBlock = msg.blocks.find(
      (b: any) => b.type === "section" && b.text?.text?.includes("Error"),
    );
    expect(errorBlock).toBeDefined();
  });

  it("truncates long error messages", () => {
    const longError = "x".repeat(500);
    const failedTask = { ...baseTask, state: "failed" as any, errorMessage: longError };
    const msg = buildSlackMessage(failedTask, "failed");
    const errorBlock = msg.blocks.find(
      (b: any) => b.type === "section" && b.text?.text?.includes("Error"),
    ) as any;
    expect(errorBlock.text.text.length).toBeLessThan(500);
    expect(errorBlock.text.text).toContain("...");
  });

  it("includes retry button for failed tasks", () => {
    const failedTask = { ...baseTask, state: "failed" as any, errorMessage: "boom" };
    const msg = buildSlackMessage(failedTask, "failed");
    const actionsBlock = msg.blocks.find((b: any) => b.type === "actions") as any;
    const retryBtn = actionsBlock.elements.find((e: any) => e.action_id === "retry_task");
    expect(retryBtn).toBeDefined();
    expect(retryBtn.value).toBe("task-123");
  });

  it("includes cancel button for needs_attention", () => {
    const msg = buildSlackMessage(baseTask, "needs_attention");
    const actionsBlock = msg.blocks.find((b: any) => b.type === "actions") as any;
    const cancelBtn = actionsBlock.elements.find((e: any) => e.action_id === "cancel_task");
    expect(cancelBtn).toBeDefined();
  });

  it("does not include retry button for completed tasks", () => {
    const msg = buildSlackMessage(baseTask, "completed");
    const actionsBlock = msg.blocks.find((b: any) => b.type === "actions") as any;
    const retryBtn = actionsBlock.elements.find((e: any) => e.action_id === "retry_task");
    expect(retryBtn).toBeUndefined();
  });

  it("always includes view logs button", () => {
    for (const state of NOTIFIABLE_STATES) {
      const msg = buildSlackMessage(baseTask, state);
      const actionsBlock = msg.blocks.find((b: any) => b.type === "actions") as any;
      const viewBtn = actionsBlock.elements.find((e: any) => e.action_id === "view_logs");
      expect(viewBtn).toBeDefined();
    }
  });

  it("sets correct color for each state", () => {
    const completedMsg = buildSlackMessage(baseTask, "completed");
    expect((completedMsg.attachments[0] as any).color).toBe("#36a64f");

    const failedMsg = buildSlackMessage({ ...baseTask, errorMessage: "err" }, "failed");
    expect((failedMsg.attachments[0] as any).color).toBe("#e01e5a");
  });

  it("handles task without PR URL or cost", () => {
    const minimalTask = {
      id: "task-456",
      title: "Minimal task",
      repoUrl: "https://github.com/org/repo",
      state: "completed" as any,
      prUrl: null,
      costUsd: null,
      errorMessage: null,
    };
    const msg = buildSlackMessage(minimalTask, "completed");
    expect(msg.text).toContain("Minimal task");
    const fieldsBlock = msg.blocks[1] as { fields: { text: string }[] };
    expect(fieldsBlock.fields.length).toBe(2); // only repo + status, no cost or PR
  });
});
