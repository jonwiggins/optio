import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockRetrieveSecret = vi.fn();
const mockStoreSecret = vi.fn();
vi.mock("./secret-service.js", () => ({
  retrieveSecret: (...args: unknown[]) => mockRetrieveSecret(...args),
  storeSecret: (...args: unknown[]) => mockStoreSecret(...args),
}));

import {
  ensureGithubWebhookSecret,
  ensureGitlabWebhookSecret,
  githubWebhookSecret,
  gitlabWebhookSecret,
  resetGithubWebhookSecretCache,
  resetGitlabWebhookSecretCache,
} from "./webhook-secret-service.js";

describe("webhook-secret-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGitlabWebhookSecretCache();
    delete process.env.GITLAB_WEBHOOK_SECRET;
  });

  afterEach(() => {
    delete process.env.GITLAB_WEBHOOK_SECRET;
  });

  it("prefers the deployment's GITLAB_WEBHOOK_SECRET over the stored one", async () => {
    process.env.GITLAB_WEBHOOK_SECRET = "from-env";
    mockRetrieveSecret.mockResolvedValue("from-store");
    expect(await gitlabWebhookSecret()).toBe("from-env");
    expect(await ensureGitlabWebhookSecret()).toBe("from-env");
    expect(mockRetrieveSecret).not.toHaveBeenCalled();
    expect(mockStoreSecret).not.toHaveBeenCalled();
  });

  it("uses the stored global secret when the environment has none, and caches it", async () => {
    mockRetrieveSecret.mockResolvedValue("from-store");
    expect(await gitlabWebhookSecret()).toBe("from-store");
    expect(await gitlabWebhookSecret()).toBe("from-store");
    expect(mockRetrieveSecret).toHaveBeenCalledTimes(1);
    expect(mockRetrieveSecret).toHaveBeenCalledWith("GITLAB_WEBHOOK_SECRET", "global");
  });

  it("is null when neither exists, and does not cache the miss", async () => {
    mockRetrieveSecret.mockRejectedValue(new Error("Secret not found"));
    expect(await gitlabWebhookSecret()).toBeNull();
    expect(await gitlabWebhookSecret()).toBeNull();
    expect(mockRetrieveSecret).toHaveBeenCalledTimes(2);
  });

  it("generates and stores a secret once, then hands back what was stored", async () => {
    let stored: string | null = null;
    mockRetrieveSecret.mockImplementation(async () => {
      if (!stored) throw new Error("Secret not found");
      return stored;
    });
    mockStoreSecret.mockImplementation(async (_name: string, value: string) => {
      stored = value;
    });

    const first = await ensureGitlabWebhookSecret();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(mockStoreSecret).toHaveBeenCalledTimes(1);
    expect(mockStoreSecret).toHaveBeenCalledWith("GITLAB_WEBHOOK_SECRET", first, "global");

    // The second caller (and the receiver) read the same value, without storing again
    expect(await ensureGitlabWebhookSecret()).toBe(first);
    expect(await gitlabWebhookSecret()).toBe(first);
    expect(mockStoreSecret).toHaveBeenCalledTimes(1);
  });
});

describe("webhook-secret-service for GitHub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGithubWebhookSecretCache();
    delete process.env.GITHUB_WEBHOOK_SECRET;
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
  });

  it("prefers the deployment's GITHUB_WEBHOOK_SECRET", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "from-env";
    expect(await githubWebhookSecret()).toBe("from-env");
    expect(mockRetrieveSecret).not.toHaveBeenCalled();
  });

  it("is null when neither the environment nor the store has one (the receiver refuses)", async () => {
    mockRetrieveSecret.mockRejectedValue(new Error("not found"));
    expect(await githubWebhookSecret()).toBeNull();
  });

  it("generates and stores its own under GITHUB_WEBHOOK_SECRET, apart from GitLab's", async () => {
    mockRetrieveSecret.mockRejectedValueOnce(new Error("not found"));
    mockRetrieveSecret.mockResolvedValueOnce("generated");
    expect(await ensureGithubWebhookSecret()).toBe("generated");
    expect(mockStoreSecret).toHaveBeenCalledWith(
      "GITHUB_WEBHOOK_SECRET",
      expect.stringMatching(/^[0-9a-f]{64}$/),
      "global",
    );
  });
});
