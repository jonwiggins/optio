import { describe, it, expect } from "vitest";
import { classifyError } from "./error-classifier.js";

describe("classifyError", () => {
  it("classifies ImagePullBackOff as image error", () => {
    const result = classifyError("Failed to pull image: ImagePullBackOff");
    expect(result.category).toBe("image");
    expect(result.title).toBe("Container image not found");
    expect(result.retryable).toBe(true);
  });

  it("classifies ErrImagePull as image error", () => {
    const result = classifyError("Error: ErrImagePull for optio-agent:latest");
    expect(result.category).toBe("image");
  });

  it("classifies pod timeout", () => {
    const result = classifyError(
      'Timed out waiting for pod "optio-task-abc" to reach Running state after 120s',
    );
    expect(result.category).toBe("timeout");
    expect(result.title).toBe("Pod startup timed out");
    expect(result.retryable).toBe(true);
  });

  it("classifies missing secret as permanent (non-retryable)", () => {
    const result = classifyError("Secret not found: ANTHROPIC_API_KEY (scope: global)");
    expect(result.category).toBe("auth");
    expect(result.title).toContain("ANTHROPIC_API_KEY");
    // Retrying without adding the secret fails identically — must be permanent
    // so provisioning fails the task instead of re-queuing forever.
    expect(result.retryable).toBe(false);
  });

  it("classifies wrapped decrypt failure with secret name", () => {
    const result = classifyError(
      'Failed to decrypt stored secret "SLACK_TOKEN" — the encryption key (OPTIO_ENCRYPTION_KEY) ' +
        "has likely changed since it was saved. Re-enter the credential, or restore the original " +
        "encryption key. (Unsupported state or unable to authenticate data)",
    );
    expect(result.category).toBe("auth");
    expect(result.title).toBe("Cannot decrypt secret: SLACK_TOKEN");
    expect(result.remedy).toContain("encryption key");
    expect(result.retryable).toBe(false);
  });

  it("classifies wrapped decrypt failure without secret name", () => {
    const result = classifyError("Failed to decrypt stored secret — the encryption key changed");
    expect(result.category).toBe("auth");
    expect(result.title).toBe("Cannot decrypt stored secret");
    expect(result.retryable).toBe(false);
  });

  it("classifies raw GCM auth failure (unwrapped)", () => {
    const result = classifyError("Error: Unsupported state or unable to authenticate data");
    expect(result.category).toBe("auth");
    expect(result.title).toBe("Cannot decrypt stored secret");
    expect(result.retryable).toBe(false);
  });

  it("prefers decrypt classification over credential-name patterns", () => {
    // The message mentions ANTHROPIC_API_KEY, but the root cause is a decrypt
    // failure — must not be classified as "Anthropic API key missing".
    const result = classifyError(
      'Failed to decrypt stored secret "ANTHROPIC_API_KEY" — the encryption key ' +
        "(OPTIO_ENCRYPTION_KEY) has likely changed since it was saved.",
    );
    expect(result.title).toBe("Cannot decrypt secret: ANTHROPIC_API_KEY");
    expect(result.retryable).toBe(false);
  });

  it("classifies invalid state transition", () => {
    const result = classifyError(
      "InvalidTransitionError: Invalid state transition: failed -> provisioning",
    );
    expect(result.category).toBe("state");
    expect(result.retryable).toBe(true);
  });

  it("classifies OOM kill", () => {
    const result = classifyError("Container was OOMKilled");
    expect(result.category).toBe("resource");
  });

  it("classifies rate limit", () => {
    const result = classifyError("API returned 429 too many requests");
    expect(result.category).toBe("auth");
    expect(result.title).toBe("API rate limit exceeded");
  });

  it("classifies network error", () => {
    const result = classifyError("ECONNREFUSED connecting to api.anthropic.com");
    expect(result.category).toBe("network");
  });

  it("classifies exit code", () => {
    const result = classifyError("Exit code: 1");
    expect(result.category).toBe("agent");
    expect(result.title).toContain("1");
  });

  it("returns unknown for unrecognized errors", () => {
    const result = classifyError("Something completely unexpected happened");
    expect(result.category).toBe("unknown");
    expect(result.description).toBe("Something completely unexpected happened");
    expect(result.retryable).toBe(true);
  });

  it("classifies missing OPENAI_API_KEY", () => {
    const result = classifyError("Secret not found: OPENAI_API_KEY");
    expect(result.category).toBe("auth");
    expect(result.title).toContain("OPENAI_API_KEY");
    expect(result.retryable).toBe(false);
  });

  it("classifies invalid Gemini API key as non-retryable auth error", () => {
    const result = classifyError(
      "Error: [400 Bad Request] API key not valid. Please pass a valid API key. [reason: API_KEY_INVALID]",
    );
    expect(result.category).toBe("auth");
    expect(result.title).toBe("Gemini API key invalid");
    expect(result.retryable).toBe(false);
  });

  it("classifies missing GEMINI_API_KEY directly", () => {
    const result = classifyError("Error: GEMINI_API_KEY environment variable is not set");
    expect(result.category).toBe("auth");
    expect(result.title).toBe("Gemini API key missing");
    expect(result.retryable).toBe(true);
  });

  it("classifies missing GEMINI_API_KEY secret as permanent", () => {
    const result = classifyError("Secret not found: GEMINI_API_KEY");
    expect(result.category).toBe("auth");
    expect(result.retryable).toBe(false);
  });

  it("classifies OpenAI API key error directly", () => {
    const result = classifyError("Error: OPENAI_API_KEY is not set or invalid");
    expect(result.category).toBe("auth");
    expect(result.title).toBe("OpenAI API key missing");
  });

  it("classifies OpenAI quota exceeded", () => {
    const result = classifyError("Error: insufficient_quota - You exceeded your current quota");
    expect(result.category).toBe("auth");
    expect(result.title).toBe("OpenAI quota exceeded");
    expect(result.retryable).toBe(false);
  });

  it("classifies OpenAI billing limit", () => {
    const result = classifyError("billing hard limit reached");
    expect(result.category).toBe("auth");
    expect(result.title).toBe("OpenAI quota exceeded");
  });

  it("classifies model not found", () => {
    const result = classifyError('The model "gpt-5" does not exist or model_not_found');
    expect(result.category).toBe("agent");
    expect(result.title).toBe("Model not found");
    expect(result.retryable).toBe(false);
  });

  it("classifies context length exceeded", () => {
    const result = classifyError(
      "This model's maximum context length is 128000 tokens. context_length exceeded",
    );
    expect(result.category).toBe("agent");
    expect(result.title).toBe("Context length exceeded");
    expect(result.retryable).toBe(false);
  });

  it("classifies content filter", () => {
    const result = classifyError("content_filter - Output blocked by content policy");
    expect(result.category).toBe("agent");
    expect(result.title).toBe("Content filter triggered");
    expect(result.retryable).toBe(false);
  });

  it("classifies ErrImageNeverPull as non-retryable image error", () => {
    const result = classifyError(
      'Pod "optio-repo-abc" failed with unrecoverable error: ErrImageNeverPull: Container image "optio-node:latest" is not present with pull policy of Never',
    );
    expect(result.category).toBe("image");
    expect(result.title).toBe("Container image not available locally");
    expect(result.retryable).toBe(false);
  });

  it("classifies InvalidImageName as non-retryable image error", () => {
    const result = classifyError("InvalidImageName: invalid reference format");
    expect(result.category).toBe("image");
    expect(result.title).toBe("Container image not available locally");
    expect(result.retryable).toBe(false);
  });

  it("handles null/undefined input", () => {
    expect(classifyError(null).category).toBe("unknown");
    expect(classifyError(undefined).category).toBe("unknown");
    expect(classifyError("").category).toBe("unknown");
  });

  it("classifies expired OAuth token and links to Secrets page", () => {
    const result = classifyError("OAuth token has expired during task execution");
    expect(result.category).toBe("auth");
    expect(result.title).toBe("Authentication token expired");
    expect(result.remedy).toContain("Secrets");
    expect(result.remedy).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("classifies 401 authentication error with secrets link", () => {
    const result = classifyError("401 authentication error from Anthropic API");
    expect(result.category).toBe("auth");
    expect(result.remedy).toContain("Secrets");
  });

  it("classifies token expired with pre-flight check message", () => {
    const result = classifyError(
      "Claude OAuth token is expired (detected by pre-flight validation). Go to Secrets to update CLAUDE_CODE_OAUTH_TOKEN.",
    );
    expect(result.category).toBe("auth");
    expect(result.title).toBe("Authentication token expired");
  });

  it("classifies GitHub secondary rate limit as non-retryable with rate-limit recovery", () => {
    const result = classifyError(
      "GitHub API error 403: You have exceeded a secondary rate limit and have been temporarily blocked from content creation.",
    );
    expect(result.category).toBe("auth");
    expect(result.title).toBe("GitHub secondary rate limit");
    expect(result.retryable).toBe(false);
    expect(result.recovery).toBe("rate-limit");
  });

  it("classifies GitHub bad credentials as non-retryable with github-token recovery", () => {
    const result = classifyError('GitHub API error 401: {"message":"Bad credentials"}');
    expect(result.title).toBe("GitHub credentials invalid");
    expect(result.retryable).toBe(false);
    expect(result.recovery).toBe("github-token");
  });

  it("classifies GitHub permission error as non-retryable with github-permission recovery", () => {
    const result = classifyError(
      'GitHub API error 403: {"message":"Resource not accessible by integration"}',
    );
    expect(result.title).toBe("GitHub permission denied");
    expect(result.retryable).toBe(false);
    expect(result.recovery).toBe("github-permission");
  });

  it("does NOT classify unrelated 'bad credentials' (no GitHub wrapper) as a GitHub error", () => {
    const result = classifyError("Internal connector rejected the request: bad credentials");
    expect(result.title).not.toBe("GitHub credentials invalid");
    expect(result.recovery).toBeUndefined();
    expect(result.category).toBe("unknown");
    expect(result.retryable).toBe(true);
  });

  it("does NOT classify an unrelated 'resource not accessible' string as a GitHub error", () => {
    const result = classifyError("resource not accessible by integration");
    expect(result.title).not.toBe("GitHub permission denied");
    expect(result.recovery).toBeUndefined();
  });

  it("still treats a non-GitHub provider rate limit as retryable (generic rule)", () => {
    const result = classifyError("API returned 429 too many requests");
    expect(result.title).toBe("API rate limit exceeded");
    expect(result.retryable).toBe(true);
    expect(result.recovery).toBeUndefined();
  });
});
