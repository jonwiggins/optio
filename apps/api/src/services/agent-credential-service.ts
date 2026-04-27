import { retrieveSecretWithFallback } from "./secret-service.js";
import { logger } from "../logger.js";

// Agent types supported by Optio
export type AgentType =
  | "claude-code"
  | "codex"
  | "copilot"
  | "gemini"
  | "groq"
  | "opencode"
  | "openclaw";

export interface AgentCredentials {
  env: Record<string, string>;
  setupFiles?: Array<{ path: string; content: string; sensitive?: boolean }>;
}

/**
 * Retrieves agent credentials for interactive sessions or tasks.
 * Handles all authentication modes:
 * - Claude: api-key, oauth-token, max-subscription, vertex-ai
 * - Codex: api-key, app-server
 * - Gemini: api-key, vertex-ai
 * - Other agents: Groq, OpenClaw, OpenCode, Copilot
 *
 * @param agentType - The agent type (claude-code, codex, gemini, copilot, groq, opencode, openclaw)
 * @param workspaceId - Workspace ID for secret resolution
 * @param userId - User ID for user-scoped secrets
 * @returns Object with env vars and optional setupFiles (for service account keys)
 */
export async function getAgentCredentials(
  agentType: AgentType,
  workspaceId?: string | null,
  userId?: string | null,
): Promise<AgentCredentials> {
  const log = logger.child({ agentType, workspaceId, userId });
  const env: Record<string, string> = {};
  const setupFiles: Array<{ path: string; content: string; sensitive?: boolean }> = [];

  // ── Claude Code credentials ──────────────────────────────────────
  if (agentType === "claude-code") {
    const claudeAuthMode =
      ((await retrieveSecretWithFallback("CLAUDE_AUTH_MODE", "global", workspaceId).catch(
        () => null,
      )) as any) ?? "api-key";

    if (claudeAuthMode === "max-subscription") {
      // Max subscription: fetch OAuth token from host keychain via auth proxy
      const { getClaudeAuthToken } = await import("./auth-service.js");
      const authResult = getClaudeAuthToken();
      if (authResult.available && authResult.token) {
        env.CLAUDE_CODE_OAUTH_TOKEN = authResult.token;
        log.info("Injected CLAUDE_CODE_OAUTH_TOKEN from host credentials");
      } else {
        log.warn({ error: authResult.error }, "Max subscription auth unavailable");
      }
    } else if (claudeAuthMode === "oauth-token") {
      // OAuth token mode: retrieve from secrets store
      const oauthToken = await retrieveSecretWithFallback(
        "CLAUDE_CODE_OAUTH_TOKEN",
        "global",
        workspaceId,
        userId,
      ).catch(() => null);
      if (oauthToken) {
        env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken as string;
        log.info("Injected CLAUDE_CODE_OAUTH_TOKEN from secrets store");
      } else {
        log.warn("OAuth token mode selected but no CLAUDE_CODE_OAUTH_TOKEN found");
      }
    } else if (claudeAuthMode === "vertex-ai") {
      // Vertex AI mode: retrieve GCP project config and optional service account key
      const projectId = await retrieveSecretWithFallback(
        "CLAUDE_VERTEX_PROJECT_ID",
        "global",
        workspaceId,
      ).catch(() => null);
      const region = await retrieveSecretWithFallback(
        "CLAUDE_VERTEX_REGION",
        "global",
        workspaceId,
      ).catch(() => null);
      const serviceAccountKey = await retrieveSecretWithFallback(
        "CLAUDE_VERTEX_SERVICE_ACCOUNT_KEY",
        "global",
        workspaceId,
        userId,
      ).catch(() => null);

      if (projectId) env.ANTHROPIC_VERTEX_PROJECT_ID = projectId as string;
      if (region) env.CLOUD_ML_REGION = region as string;
      env.CLAUDE_CODE_USE_VERTEX = "1";

      // If service account key provided, write it as a sensitive file
      // Otherwise, fall back to workload identity
      if (serviceAccountKey) {
        setupFiles.push({
          path: "/home/agent/.config/gcloud/gsa-key.json",
          content: serviceAccountKey as string,
          sensitive: true,
        });
        env.GOOGLE_APPLICATION_CREDENTIALS = "/home/agent/.config/gcloud/gsa-key.json";
        log.info("Injected CLAUDE_VERTEX_SERVICE_ACCOUNT_KEY as sensitive file");
      } else {
        log.info("Using GKE workload identity for Vertex AI (no service account key provided)");
      }
    } else if (claudeAuthMode === "api-key") {
      // API key mode: retrieve ANTHROPIC_API_KEY
      const apiKey = await retrieveSecretWithFallback(
        "ANTHROPIC_API_KEY",
        "global",
        workspaceId,
        userId,
      ).catch(() => null);
      if (apiKey) {
        env.ANTHROPIC_API_KEY = apiKey as string;
        log.info("Injected ANTHROPIC_API_KEY from secrets store");
      } else {
        log.warn("API key mode selected but no ANTHROPIC_API_KEY found");
      }
    }
  }

  // ── Codex credentials ────────────────────────────────────────────
  if (agentType === "codex") {
    const codexAuthMode =
      ((await retrieveSecretWithFallback("CODEX_AUTH_MODE", "global", workspaceId).catch(
        () => null,
      )) as any) ?? "api-key";

    if (codexAuthMode === "app-server") {
      const appServerUrl = await retrieveSecretWithFallback(
        "CODEX_APP_SERVER_URL",
        "global",
        workspaceId,
      ).catch(() => null);
      if (appServerUrl) {
        env.CODEX_APP_SERVER_URL = appServerUrl as string;
        log.info("Injected CODEX_APP_SERVER_URL from secrets store");
      }
    } else {
      // API key mode
      const apiKey = await retrieveSecretWithFallback(
        "OPENAI_API_KEY",
        "global",
        workspaceId,
        userId,
      ).catch(() => null);
      if (apiKey) {
        env.OPENAI_API_KEY = apiKey as string;
        log.info("Injected OPENAI_API_KEY from secrets store");
      } else {
        log.warn("Codex API key mode selected but no OPENAI_API_KEY found");
      }
    }
  }

  // ── Gemini credentials ───────────────────────────────────────────
  if (agentType === "gemini") {
    const geminiAuthMode =
      ((await retrieveSecretWithFallback("GEMINI_AUTH_MODE", "global", workspaceId).catch(
        () => null,
      )) as any) ?? "api-key";

    if (geminiAuthMode === "vertex-ai") {
      const projectId = await retrieveSecretWithFallback(
        "GOOGLE_CLOUD_PROJECT",
        "global",
        workspaceId,
      ).catch(() => null);
      const location = await retrieveSecretWithFallback(
        "GOOGLE_CLOUD_LOCATION",
        "global",
        workspaceId,
      ).catch(() => null);

      if (projectId) env.GOOGLE_CLOUD_PROJECT = projectId as string;
      if (location) env.GOOGLE_CLOUD_LOCATION = location as string;
      log.info("Configured Gemini Vertex AI");
    } else {
      // API key mode
      const apiKey = await retrieveSecretWithFallback(
        "GEMINI_API_KEY",
        "global",
        workspaceId,
        userId,
      ).catch(() => null);
      if (apiKey) {
        env.GEMINI_API_KEY = apiKey as string;
        log.info("Injected GEMINI_API_KEY from secrets store");
      } else {
        // Try legacy GOOGLE_GENAI_API_KEY
        const legacyKey = await retrieveSecretWithFallback(
          "GOOGLE_GENAI_API_KEY",
          "global",
          workspaceId,
          userId,
        ).catch(() => null);
        if (legacyKey) {
          env.GOOGLE_GENAI_API_KEY = legacyKey as string;
          log.info("Injected GOOGLE_GENAI_API_KEY from secrets store");
        } else {
          log.warn("Gemini API key mode selected but no GEMINI_API_KEY found");
        }
      }
    }
  }

  // ── Copilot credentials ──────────────────────────────────────────
  if (agentType === "copilot") {
    const apiKey = await retrieveSecretWithFallback(
      "GITHUB_TOKEN",
      "global",
      workspaceId,
      userId,
    ).catch(() => null);
    if (apiKey) {
      env.GITHUB_TOKEN = apiKey as string;
      log.info("Injected GITHUB_TOKEN for Copilot");
    }
  }

  // ── Groq credentials ─────────────────────────────────────────────
  if (agentType === "groq") {
    const apiKey = await retrieveSecretWithFallback(
      "GROQ_API_KEY",
      "global",
      workspaceId,
      userId,
    ).catch(() => null);
    if (apiKey) {
      env.GROQ_API_KEY = apiKey as string;
      log.info("Injected GROQ_API_KEY from secrets store");
    } else {
      log.warn("No GROQ_API_KEY found");
    }
  }

  // ── OpenClaw credentials ─────────────────────────────────────────
  if (agentType === "openclaw") {
    const apiKey = await retrieveSecretWithFallback(
      "OPENCLAW_API_KEY",
      "global",
      workspaceId,
      userId,
    ).catch(() => null);
    if (apiKey) {
      env.OPENCLAW_API_KEY = apiKey as string;
      log.info("Injected OPENCLAW_API_KEY from secrets store");
    } else {
      log.warn("No OPENCLAW_API_KEY found");
    }
  }

  // ── OpenCode credentials ─────────────────────────────────────────
  if (agentType === "opencode") {
    const baseUrl = await retrieveSecretWithFallback(
      "OPENCODE_DEFAULT_BASE_URL",
      "global",
      workspaceId,
    ).catch(() => null);
    const model = await retrieveSecretWithFallback(
      "OPENCODE_DEFAULT_MODEL",
      "global",
      workspaceId,
    ).catch(() => null);

    if (baseUrl) env.OPENCODE_DEFAULT_BASE_URL = baseUrl as string;
    if (model) env.OPENCODE_DEFAULT_MODEL = model as string;
    log.info("Configured OpenCode defaults");
  }

  return { env, setupFiles: setupFiles.length > 0 ? setupFiles : undefined };
}
