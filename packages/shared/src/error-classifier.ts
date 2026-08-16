export interface ClassifiedError {
  category: "image" | "auth" | "network" | "timeout" | "agent" | "state" | "resource" | "unknown";
  title: string;
  description: string;
  remedy: string;
  retryable: boolean;
  /**
   * Stable discriminator for which provider-specific recovery surface the UI
   * should render. Absent for generic errors. Set explicitly by classifiers so
   * renderers never have to infer the provider from display-title text.
   */
  recovery?: "claude-token" | "github-token" | "github-permission" | "rate-limit";
}

const ERROR_PATTERNS: Array<{
  pattern: RegExp;
  classify: (match: RegExpMatchArray) => ClassifiedError;
}> = [
  // ── GitHub write-path failures ──────────────────────────────────────────
  // Must precede the generic rate-limit rule and the LLM auth rule. Scoped to
  // the verified `GitHub API error <status>: <body>` wrapper that GitHubPlatform
  // produces, so an unrelated provider/service emitting e.g. "bad credentials"
  // is NOT misclassified as a permanent GitHub failure. `recovery` tells the UI
  // which provider-specific recovery surface to render.
  {
    pattern: /github api error \d+:.*(secondary rate limit|abuse detection)/is,
    classify: () => ({
      category: "auth",
      title: "GitHub secondary rate limit",
      description:
        "GitHub temporarily blocked writes (PRs, comments, reviews, merges) because too many " +
        "content-creating requests were sent too quickly. This is a secondary rate limit, separate " +
        "from the primary hourly quota.",
      remedy:
        "Stop retrying immediately. Wait at least 60 seconds (honor the Retry-After header if present) " +
        "before further GitHub writes, and reduce concurrent agents/auto-resumes if it recurs.",
      retryable: false,
      recovery: "rate-limit",
    }),
  },
  {
    pattern: /github api error \d+:.*bad credentials/is,
    classify: () => ({
      category: "auth",
      title: "GitHub credentials invalid",
      description:
        "GitHub rejected the token (HTTP 401 Bad credentials). The configured GitHub token is missing, " +
        "expired, or revoked. Retrying with the same token will keep failing.",
      remedy:
        "Reconnect the GitHub App or refresh the GITHUB_TOKEN secret. Do not retry until the credential " +
        "is replaced.",
      retryable: false,
      recovery: "github-token",
    }),
  },
  {
    pattern:
      /github api error \d+:.*resource not accessible by (integration|personal access token|fine-grained personal access token)/is,
    classify: () => ({
      category: "auth",
      title: "GitHub permission denied",
      description:
        "The GitHub token authenticated but lacks permission for this operation (HTTP 403 Resource not " +
        "accessible). The App installation or token is missing a required scope/permission.",
      remedy:
        "Grant the missing permission to the GitHub App installation (or PAT scopes) — e.g. Pull requests: " +
        "write, Issues: write, Contents: write — then retry.",
      retryable: false,
      recovery: "github-permission",
    }),
  },
  {
    pattern: /ErrImageNeverPull|InvalidImageName/i,
    classify: (match) => {
      const reason = match[0];
      return {
        category: "image",
        title: "Container image not available locally",
        description: `Pod failed with ${reason}. The image pull policy is set to "Never" but the required image does not exist on the node. This will never succeed without building the image first.`,
        remedy:
          "Build the missing image locally:\n  ./images/build.sh <preset>\nFor example: ./images/build.sh node\nThen retry the task.",
        retryable: false,
      };
    },
  },
  {
    pattern: /ImagePullBackOff|ErrImagePull|failed to pull.*image/i,
    classify: () => ({
      category: "image",
      title: "Container image not found",
      description:
        "Kubernetes could not pull the agent container image. This usually means the image hasn't been built locally or isn't accessible from the cluster.",
      remedy:
        "Run: docker build -t optio-agent:latest -f Dockerfile.agent .\nThen ensure OPTIO_IMAGE_PULL_POLICY=Never is set in your .env file.",
      retryable: true,
    }),
  },
  {
    pattern: /Timed out waiting for pod.*Running.*after (\d+)s/i,
    classify: (match) => ({
      category: "timeout",
      title: "Pod startup timed out",
      description: `The agent pod did not reach Running state within ${match[1]}s. This could be caused by image pull issues, resource constraints, or scheduling problems.`,
      remedy:
        "Check the Cluster page for pod status and events. Common causes:\n- Image not built (run docker build)\n- Insufficient cluster resources\n- Node scheduling issues",
      retryable: true,
    }),
  },
  // A missing required secret is a configuration error, not a transient one —
  // retrying without adding the secret fails identically every time (and used
  // to bounce tasks queued↔provisioning forever). Marked non-retryable so the
  // provisioning path fails the task immediately with an actionable message.
  // The pattern is scoped to the exact message secret-service.retrieveSecret()
  // throws ("Secret not found: NAME (scope: ...)"), not arbitrary errors that
  // merely mention secrets.
  {
    pattern: /Secret not found: (\w+)/i,
    classify: (match) => ({
      category: "auth",
      title: `Missing secret: ${match[1]}`,
      description: `The required secret "${match[1]}" is not configured. The agent needs this credential to run, and retrying without adding it will fail again.`,
      remedy: `Go to Secrets and add "${match[1]}" (or re-run the setup wizard), then retry the task.`,
      retryable: false,
    }),
  },
  // Must precede the credential-name patterns (ANTHROPIC_API_KEY, OPENAI_API_KEY, …)
  // so a decrypt failure mentioning a secret's name isn't misclassified as a
  // missing key. Matches both the wrapped message from secret-service.decrypt()
  // and Node's raw AES-GCM auth failure in case it surfaces unwrapped.
  {
    pattern:
      /failed to decrypt stored secret(?: "([^"]+)")?|unsupported state or unable to authenticate data/i,
    classify: (match) => {
      const name = match[1];
      return {
        category: "auth",
        title: name ? `Cannot decrypt secret: ${name}` : "Cannot decrypt stored secret",
        description:
          `A stored secret${name ? ` ("${name}")` : ""} could not be decrypted. This almost always ` +
          "means the encryption key (OPTIO_ENCRYPTION_KEY) changed after the secret was saved — " +
          "for example, a redeploy generated a fresh key — so decryption fails for every " +
          "previously stored credential.",
        remedy:
          "Re-enter the affected credentials under Secrets (or re-run the setup wizard), or " +
          "restore the original encryption key (Helm value encryption.key) and redeploy. " +
          "Retrying without doing one of these will keep failing.",
        retryable: false,
      };
    },
  },
  {
    pattern:
      /OAuth token has expired|authentication_failed|token.*expired|401.*authentication|pre-flight validation/i,
    classify: () => ({
      category: "auth",
      title: "Authentication token expired",
      description:
        "The Claude Code OAuth token has expired. The agent cannot authenticate with the Anthropic API. " +
        "Keychain-sourced tokens expire roughly every hour.",
      remedy:
        "Go to Secrets and update CLAUDE_CODE_OAUTH_TOKEN with a fresh token.\n\n" +
        "To copy from your macOS Keychain, run:\n" +
        "  security find-generic-password -s \"Claude Code-credentials\" -w | python3 -c \"import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])\" | pbcopy\n\n" +
        "Or re-run 'claude setup-token' to go through the setup flow again.\n" +
        "Retry the failed tasks after updating the token.",
      retryable: true,
    }),
  },
  {
    pattern: /ANTHROPIC_API_KEY/i,
    classify: () => ({
      category: "auth",
      title: "Anthropic API key missing",
      description: "No Anthropic API key is configured and Claude Code cannot authenticate.",
      remedy:
        "Go to Secrets and add ANTHROPIC_API_KEY, or switch to Max subscription auth in Settings.",
      retryable: true,
    }),
  },
  {
    pattern: /OPENAI_API_KEY/i,
    classify: () => ({
      category: "auth",
      title: "OpenAI API key missing",
      description:
        "No OpenAI API key is configured and the Codex agent cannot authenticate with the OpenAI API.",
      remedy: "Go to Secrets and add OPENAI_API_KEY with a valid OpenAI API key.",
      retryable: true,
    }),
  },
  {
    pattern: /OPENCLAW_API_KEY/i,
    classify: () => ({
      category: "auth",
      title: "OpenClaw API key missing",
      description: "No OpenClaw API key is configured and the OpenClaw agent cannot authenticate.",
      remedy:
        "Go to Secrets and add OPENCLAW_API_KEY, or provide an ANTHROPIC_API_KEY or OPENAI_API_KEY instead.",
      retryable: true,
    }),
  },
  {
    pattern: /CURSOR_API_KEY/i,
    classify: () => ({
      category: "auth",
      title: "Cursor API key missing or invalid",
      description:
        "No valid Cursor API key is configured and the Cursor agent cannot authenticate.",
      remedy:
        "Go to Secrets and add CURSOR_API_KEY with an API key from cursor.com dashboard settings, then retry the task.",
      retryable: true,
    }),
  },
  {
    // Gemini API rejects bad keys with "API key not valid. Please pass a
    // valid API key." and reason API_KEY_INVALID.
    pattern: /API[_ ]?KEY[_ ]?INVALID|API key not valid/i,
    classify: () => ({
      category: "auth",
      title: "Gemini API key invalid",
      description: "The configured Gemini API key was rejected by the Google AI API.",
      remedy:
        "Go to Secrets and update GEMINI_API_KEY with a valid key from Google AI Studio, then retry the task.",
      retryable: false,
    }),
  },
  {
    pattern: /GEMINI_API_KEY/i,
    classify: () => ({
      category: "auth",
      title: "Gemini API key missing",
      description: "No Gemini API key is configured and the Gemini agent cannot authenticate.",
      remedy: "Go to Secrets and add GEMINI_API_KEY, or switch the repo to Vertex AI auth.",
      retryable: true,
    }),
  },
  {
    pattern: /COPILOT_GITHUB_TOKEN|copilot.*auth|copilot.*unauthorized|subscription.*required/i,
    classify: () => ({
      category: "auth",
      title: "GitHub Copilot token missing or invalid",
      description:
        "No valid Copilot token is configured. The Copilot agent requires a GitHub token with Copilot Requests permission and an active Copilot subscription.",
      remedy:
        "Go to Secrets and add COPILOT_GITHUB_TOKEN with a fine-grained PAT that has the Copilot Requests permission. Classic PATs (ghp_) are not supported.",
      retryable: true,
    }),
  },
  {
    pattern: /insufficient_quota|billing.*hard.*limit|exceeded.*current.*quota/i,
    classify: () => ({
      category: "auth",
      title: "OpenAI quota exceeded",
      description:
        "The OpenAI API key has exceeded its usage quota. The Codex agent cannot make API calls.",
      remedy:
        "Check your OpenAI billing dashboard and increase your spending limit, or use a different API key.",
      retryable: false,
    }),
  },
  {
    pattern: /model.*not.?found|model_not_found|does not exist.*model|invalid.*model/i,
    classify: () => ({
      category: "agent",
      title: "Model not found",
      description: "The requested model does not exist or your API key does not have access to it.",
      remedy:
        "Check the model name in your repo settings. Ensure your OpenAI account has access to the model.",
      retryable: false,
    }),
  },
  {
    pattern: /context.?length.*exceeded|maximum.?context|too many tokens|token.?limit/i,
    classify: () => ({
      category: "agent",
      title: "Context length exceeded",
      description:
        "The agent's input exceeded the model's maximum context window. The task prompt or repository content may be too large.",
      remedy: "Try reducing the prompt length, or use a model with a larger context window.",
      retryable: false,
    }),
  },
  {
    pattern: /content.?filter|content.?policy|safety.?system/i,
    classify: () => ({
      category: "agent",
      title: "Content filter triggered",
      description:
        "The OpenAI content filter blocked the request. The task prompt or generated output may have triggered a safety policy.",
      remedy:
        "Review the task prompt for content that may trigger safety filters. Rephrase if needed.",
      retryable: false,
    }),
  },
  {
    pattern: /InvalidTransitionError.*(\w+) -> (\w+)/i,
    classify: (match) => ({
      category: "state",
      title: "Invalid state transition",
      description: `The task tried to move from "${match[1]}" to "${match[2]}" which is not allowed. This usually indicates a stale job retry from BullMQ.`,
      remedy: "This is typically self-resolving. Click Retry to re-queue the task cleanly.",
      retryable: true,
    }),
  },
  {
    pattern: /OOMKilled|out of memory/i,
    classify: () => ({
      category: "resource",
      title: "Out of memory",
      description: "The agent container was killed because it exceeded its memory limit.",
      remedy:
        "Increase the memory limit in the repo's container settings, or use a larger image preset.",
      retryable: true,
    }),
  },
  {
    pattern: /rate.?limit|429|too many requests/i,
    classify: () => ({
      category: "auth",
      title: "API rate limit exceeded",
      description:
        "The agent hit an API rate limit. This can happen with heavy usage on subscription plans.",
      remedy:
        "Wait a few minutes before retrying, or switch to API key auth with higher rate limits.",
      retryable: true,
    }),
  },
  {
    pattern: /GitHub access revoked|github.*app.*authorization.*revoked|bad_refresh_token/i,
    classify: () => ({
      category: "auth",
      title: "GitHub access revoked",
      description:
        "The user's GitHub App authorization has been revoked. The agent can no longer access GitHub on their behalf.",
      remedy:
        "The user needs to log in again via GitHub to re-authorize the application. Go to Settings > Applications on GitHub to verify the app is authorized.",
      retryable: false,
    }),
  },
  {
    pattern: /GitHub user token expired|refresh_token.*expired/i,
    classify: () => ({
      category: "auth",
      title: "GitHub token expired",
      description:
        "The user's GitHub refresh token has expired (6-month lifetime). A fresh login is required.",
      remedy: "Log out and log back in via GitHub to obtain a fresh token.",
      retryable: false,
    }),
  },
  {
    pattern: /ECONNREFUSED|ENOTFOUND|network|connection refused/i,
    classify: () => ({
      category: "network",
      title: "Network error",
      description:
        "The agent could not connect to a required service. This could be the GitHub API, Anthropic API, or an internal service.",
      remedy:
        "Check that port-forwards are running (kubectl port-forward) and external APIs are reachable.",
      retryable: true,
    }),
  },
  {
    pattern: /exit code: (\d+)/i,
    classify: (match) => ({
      category: "agent",
      title: `Agent exited with code ${match[1]}`,
      description:
        "The coding agent process exited with a non-zero exit code. Check the logs for details about what went wrong.",
      remedy:
        "Review the task logs for error messages. The agent may have encountered an issue it couldn't resolve.",
      retryable: true,
    }),
  },
];

export function classifyError(errorMessage: string | null | undefined): ClassifiedError {
  if (!errorMessage) {
    return {
      category: "unknown",
      title: "Unknown error",
      description: "The task failed but no error details were captured.",
      remedy: "Try retrying the task. If it fails again, check the API server logs.",
      retryable: true,
    };
  }

  for (const { pattern, classify } of ERROR_PATTERNS) {
    const match = errorMessage.match(pattern);
    if (match) return classify(match);
  }

  return {
    category: "unknown",
    title: "Task failed",
    description: errorMessage,
    remedy: "Review the error message and task logs for more details.",
    retryable: true,
  };
}
