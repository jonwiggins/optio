import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  shouldNotifySlack,
  isNotifiableState,
  buildSlackMessage,
  NOTIFIABLE_STATES,
  resolveSlackConfig,
  sendSlackNotification,
  notifySlackOnTransition,
  handleSlackAction,
} from "./slack-service.js";
import type { RepoRecord } from "./repo-service.js";

// --- Mocks for async-imported modules ---

vi.mock("./secret-service.js", () => ({
  retrieveSecret: vi.fn(),
}));

vi.mock("./task-service.js", () => ({
  getTask: vi.fn(),
  transitionTask: vi.fn(),
}));

vi.mock("../workers/task-worker.js", () => ({
  taskQueue: { add: vi.fn() },
}));

vi.stubGlobal(
  "fetch",
  vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve("ok") })),
);

function makeRepoConfig(overrides: Partial<RepoRecord> = {}): RepoRecord {
  return {
    id: "repo-1",
    repoUrl: "https://github.com/test/repo",
    gitPlatform: "github",
    workspaceId: null,
    fullName: "test/repo",
    defaultBranch: "main",
    isPrivate: false,
    imagePreset: "node",
    extraPackages: null,
    setupCommands: null,
    customDockerfile: null,
    autoMerge: false,
    cautiousMode: false,
    planningModeEnabled: false,
    defaultAgentType: "claude-code",
    promptTemplateOverride: null,
    claudeModel: "opus",
    claudeContextWindow: "1m",
    claudeThinking: true,
    claudeEffort: "high",
    copilotModel: null,
    copilotEffort: null,
    opencodeModel: null,
    opencodeAgent: null,
    opencodeProvider: null,
    opencodeBaseUrl: null,
    geminiModel: "gemini-2.5-pro",
    geminiApprovalMode: "yolo",
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
    reviewAgentType: null,
    reviewModel: "sonnet",
    externalReviewMode: "off",
    externalReviewFilters: null,
    externalReviewWaitForCi: true,
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

// ---------------------------------------------------------------------------
// Tests for async / side-effecting exports
// ---------------------------------------------------------------------------

describe("resolveSlackConfig", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns repo webhook URL and channel when configured", async () => {
    const repo = makeRepoConfig({
      slackWebhookUrl: "https://hooks.slack.com/services/T01/B01/repo",
      slackChannel: "#deployments",
    });
    const result = await resolveSlackConfig(repo);
    expect(result).toEqual({
      webhookUrl: "https://hooks.slack.com/services/T01/B01/repo",
      channel: "#deployments",
    });
  });

  it("falls back to global webhook from secret-service when repo has none", async () => {
    const { retrieveSecret } = await import("./secret-service.js");
    const mockRetrieve = vi.mocked(retrieveSecret);
    mockRetrieve.mockResolvedValueOnce("https://hooks.slack.com/services/T01/B01/global");

    const repo = makeRepoConfig({ slackWebhookUrl: null, slackEnabled: false });
    const result = await resolveSlackConfig(repo);
    expect(result).toEqual({ webhookUrl: "https://hooks.slack.com/services/T01/B01/global" });
    expect(mockRetrieve).toHaveBeenCalledWith("SLACK_WEBHOOK_URL");
  });

  it("returns null when neither repo nor global webhook is configured", async () => {
    const { retrieveSecret } = await import("./secret-service.js");
    vi.mocked(retrieveSecret).mockRejectedValueOnce(new Error("not found"));

    const repo = makeRepoConfig({ slackWebhookUrl: null, slackEnabled: false });
    const result = await resolveSlackConfig(repo);
    expect(result).toBeNull();
  });

  it("returns null when repo config is null", async () => {
    const { retrieveSecret } = await import("./secret-service.js");
    vi.mocked(retrieveSecret).mockRejectedValueOnce(new Error("not found"));

    const result = await resolveSlackConfig(null);
    expect(result).toBeNull();
  });
});

describe("sendSlackNotification", () => {
  const task = {
    id: "task-send-1",
    title: "Deploy widget",
    repoUrl: "https://github.com/acme/widget",
    state: "completed" as any,
    prUrl: null,
    costUsd: null,
    errorMessage: null,
  };

  beforeEach(() => vi.clearAllMocks());

  it("sends POST to webhook URL with correct Block Kit payload", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve("ok") } as Response);

    await sendSlackNotification("https://hooks.slack.com/services/T/B/x", task, "completed");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/services/T/B/x");
    expect(opts!.method).toBe("POST");
    expect(opts!.headers).toEqual({ "Content-Type": "application/json" });

    const body = JSON.parse(opts!.body as string);
    expect(body.text).toContain("Deploy widget");
    expect(body.blocks).toBeDefined();
    expect(body.attachments).toBeDefined();
    expect(body.channel).toBeUndefined();
  });

  it("includes channel in payload when provided", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve("ok") } as Response);

    await sendSlackNotification(
      "https://hooks.slack.com/services/T/B/x",
      task,
      "completed",
      "#ops",
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
    expect(body.channel).toBe("#ops");
  });

  it("throws when webhook returns non-OK response", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("server error"),
    } as Response);

    await expect(
      sendSlackNotification("https://hooks.slack.com/services/T/B/x", task, "completed"),
    ).rejects.toThrow("Slack webhook returned 500: server error");
  });
});

describe("notifySlackOnTransition", () => {
  const task = {
    id: "task-notify-1",
    title: "Fix bug",
    repoUrl: "https://github.com/acme/widget",
    state: "failed" as any,
    prUrl: null,
    costUsd: null,
    errorMessage: "boom",
  };

  beforeEach(() => vi.clearAllMocks());

  it("sends notification for notifiable state with valid config", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve("ok") } as Response);

    const repo = makeRepoConfig();
    await notifySlackOnTransition(task, "failed", repo);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/services/T00/B00/xxx");
  });

  it("skips non-notifiable states silently", async () => {
    const mockFetch = vi.mocked(fetch);
    const repo = makeRepoConfig();

    await notifySlackOnTransition(task, "running", repo);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("catches and logs errors without throwing", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    const repo = makeRepoConfig();

    // Should NOT throw despite internal error
    await expect(notifySlackOnTransition(task, "failed", repo)).resolves.toBeUndefined();
  });
});

describe("handleSlackAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retries failed task on retry_task action", async () => {
    const taskService = await import("./task-service.js");
    const { taskQueue } = await import("../workers/task-worker.js");

    vi.mocked(taskService.getTask).mockResolvedValueOnce({
      id: "task-ha-1",
      title: "Retry me",
      state: "failed",
    } as any);
    vi.mocked(taskService.transitionTask).mockResolvedValueOnce(undefined as any);
    vi.mocked(taskQueue.add).mockResolvedValueOnce(undefined as any);

    const result = await handleSlackAction("retry_task", "task-ha-1");

    expect(taskService.transitionTask).toHaveBeenCalledWith("task-ha-1", "queued", "slack_retry");
    expect(taskQueue.add).toHaveBeenCalledWith(
      "process-task",
      { taskId: "task-ha-1" },
      expect.objectContaining({ attempts: 1 }),
    );
    expect(result.text).toContain("Retry me");
    expect(result.text).toContain("queued for retry");
  });

  it("cancels task on cancel_task action", async () => {
    const taskService = await import("./task-service.js");

    vi.mocked(taskService.getTask).mockResolvedValueOnce({
      id: "task-ha-2",
      title: "Cancel me",
      state: "running",
    } as any);
    vi.mocked(taskService.transitionTask).mockResolvedValueOnce(undefined as any);

    const result = await handleSlackAction("cancel_task", "task-ha-2");

    expect(taskService.transitionTask).toHaveBeenCalledWith(
      "task-ha-2",
      "cancelled",
      "slack_cancel",
    );
    expect(result.text).toContain("Cancel me");
    expect(result.text).toContain("cancelled");
  });

  it("returns error message when task not found", async () => {
    const taskService = await import("./task-service.js");
    vi.mocked(taskService.getTask).mockResolvedValueOnce(null as any);

    const result = await handleSlackAction("retry_task", "task-missing");

    expect(result.text).toContain("Task not found");
    expect(result.text).toContain("task-missing");
  });

  it("returns error message on transition failure", async () => {
    const taskService = await import("./task-service.js");

    vi.mocked(taskService.getTask).mockResolvedValueOnce({
      id: "task-ha-3",
      title: "Fail transition",
      state: "completed",
    } as any);
    vi.mocked(taskService.transitionTask).mockRejectedValueOnce(
      new Error("Invalid transition from completed to queued"),
    );

    const result = await handleSlackAction("retry_task", "task-ha-3");

    expect(result.text).toContain("Failed to retry task");
    expect(result.text).toContain("Invalid transition");
  });

  it("returns unknown action message for unrecognized actions", async () => {
    const result = await handleSlackAction("do_something_weird", "task-ha-4");

    expect(result.text).toContain("Unknown action");
    expect(result.text).toContain("do_something_weird");
  });
});
