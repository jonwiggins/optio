import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAgentCredentials } from "./agent-credential-service.js";

// Mock dependencies
vi.mock("./secret-service.js", () => ({
  retrieveSecretWithFallback: vi.fn(),
}));

vi.mock("./auth-service.js", () => ({
  getClaudeAuthToken: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: {
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

import { retrieveSecretWithFallback } from "./secret-service.js";
import { getClaudeAuthToken } from "./auth-service.js";

describe("agent-credential-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getAgentCredentials - Claude Code", () => {
    it("injects ANTHROPIC_API_KEY in api-key mode", async () => {
      vi.mocked(retrieveSecretWithFallback).mockImplementation(
        async (name: string): Promise<string> => {
          if (name === "CLAUDE_AUTH_MODE") return "api-key";
          if (name === "ANTHROPIC_API_KEY") return "sk-ant-test-key";
          throw new Error("Secret not found");
        },
      );

      const result = await getAgentCredentials("claude-code", "workspace-1", "user-1");

      expect(result.env.ANTHROPIC_API_KEY).toBe("sk-ant-test-key");
      expect(result.setupFiles).toBeUndefined();
    });

    it("injects CLAUDE_CODE_OAUTH_TOKEN in oauth-token mode", async () => {
      vi.mocked(retrieveSecretWithFallback).mockImplementation(
        async (name: string): Promise<string> => {
          if (name === "CLAUDE_AUTH_MODE") return "oauth-token";
          if (name === "CLAUDE_CODE_OAUTH_TOKEN") return "oauth-token-123";
          throw new Error("Secret not found");
        },
      );

      const result = await getAgentCredentials("claude-code", "workspace-1", "user-1");

      expect(result.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token-123");
      expect(result.setupFiles).toBeUndefined();
    });

    it("injects CLAUDE_CODE_OAUTH_TOKEN from host in max-subscription mode", async () => {
      vi.mocked(retrieveSecretWithFallback).mockImplementation(
        async (name: string): Promise<string> => {
          if (name === "CLAUDE_AUTH_MODE") return "max-subscription";
          throw new Error("Secret not found");
        },
      );

      vi.mocked(getClaudeAuthToken).mockReturnValue({
        available: true,
        token: "host-oauth-token",
      });

      const result = await getAgentCredentials("claude-code", "workspace-1", "user-1");

      expect(result.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("host-oauth-token");
      expect(result.setupFiles).toBeUndefined();
    });

    it("configures Vertex AI with service account key", async () => {
      const mockServiceAccountKey = JSON.stringify({
        type: "service_account",
        project_id: "test-project",
        private_key: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
        client_email: "test@test.iam.gserviceaccount.com",
      });

      vi.mocked(retrieveSecretWithFallback).mockImplementation(
        async (name: string): Promise<string> => {
          if (name === "CLAUDE_AUTH_MODE") return "vertex-ai";
          if (name === "CLAUDE_VERTEX_PROJECT_ID") return "test-project";
          if (name === "CLAUDE_VERTEX_REGION") return "us-central1";
          if (name === "CLAUDE_VERTEX_SERVICE_ACCOUNT_KEY") return mockServiceAccountKey;
          throw new Error("Secret not found");
        },
      );

      const result = await getAgentCredentials("claude-code", "workspace-1", "user-1");

      expect(result.env.ANTHROPIC_VERTEX_PROJECT_ID).toBe("test-project");
      expect(result.env.CLOUD_ML_REGION).toBe("us-central1");
      expect(result.env.CLAUDE_CODE_USE_VERTEX).toBe("1");
      expect(result.env.GOOGLE_APPLICATION_CREDENTIALS).toBe(
        "/home/agent/.config/gcloud/gsa-key.json",
      );
      expect(result.setupFiles).toHaveLength(1);
      expect(result.setupFiles![0].path).toBe("/home/agent/.config/gcloud/gsa-key.json");
      expect(result.setupFiles![0].content).toBe(mockServiceAccountKey);
      expect(result.setupFiles![0].sensitive).toBe(true);
    });

    it("uses workload identity when no service account key provided (Vertex AI)", async () => {
      vi.mocked(retrieveSecretWithFallback).mockImplementation(
        async (name: string): Promise<string> => {
          if (name === "CLAUDE_AUTH_MODE") return "vertex-ai";
          if (name === "CLAUDE_VERTEX_PROJECT_ID") return "test-project";
          if (name === "CLAUDE_VERTEX_REGION") return "us-central1";
          // No service account key
          throw new Error("Secret not found");
        },
      );

      const result = await getAgentCredentials("claude-code", "workspace-1", "user-1");

      expect(result.env.ANTHROPIC_VERTEX_PROJECT_ID).toBe("test-project");
      expect(result.env.CLOUD_ML_REGION).toBe("us-central1");
      expect(result.env.CLAUDE_CODE_USE_VERTEX).toBe("1");
      expect(result.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
      expect(result.setupFiles).toBeUndefined();
    });
  });

  describe("getAgentCredentials - Codex", () => {
    it("injects OPENAI_API_KEY in api-key mode", async () => {
      vi.mocked(retrieveSecretWithFallback).mockImplementation(
        async (name: string): Promise<string> => {
          if (name === "CODEX_AUTH_MODE") return "api-key";
          if (name === "OPENAI_API_KEY") return "sk-openai-test";
          throw new Error("Secret not found");
        },
      );

      const result = await getAgentCredentials("codex", "workspace-1", "user-1");

      expect(result.env.OPENAI_API_KEY).toBe("sk-openai-test");
    });

    it("injects CODEX_APP_SERVER_URL in app-server mode", async () => {
      vi.mocked(retrieveSecretWithFallback).mockImplementation(
        async (name: string): Promise<string> => {
          if (name === "CODEX_AUTH_MODE") return "app-server";
          if (name === "CODEX_APP_SERVER_URL") return "https://codex-server.example.com";
          throw new Error("Secret not found");
        },
      );

      const result = await getAgentCredentials("codex", "workspace-1", "user-1");

      expect(result.env.CODEX_APP_SERVER_URL).toBe("https://codex-server.example.com");
    });
  });

  describe("getAgentCredentials - Gemini", () => {
    it("injects GEMINI_API_KEY in api-key mode", async () => {
      vi.mocked(retrieveSecretWithFallback).mockImplementation(
        async (name: string): Promise<string> => {
          if (name === "GEMINI_AUTH_MODE") return "api-key";
          if (name === "GEMINI_API_KEY") return "gemini-key-123";
          throw new Error("Secret not found");
        },
      );

      const result = await getAgentCredentials("gemini", "workspace-1", "user-1");

      expect(result.env.GEMINI_API_KEY).toBe("gemini-key-123");
    });

    it("configures Vertex AI for Gemini", async () => {
      vi.mocked(retrieveSecretWithFallback).mockImplementation(
        async (name: string): Promise<string> => {
          if (name === "GEMINI_AUTH_MODE") return "vertex-ai";
          if (name === "GOOGLE_CLOUD_PROJECT") return "gemini-project";
          if (name === "GOOGLE_CLOUD_LOCATION") return "us-west1";
          throw new Error("Secret not found");
        },
      );

      const result = await getAgentCredentials("gemini", "workspace-1", "user-1");

      expect(result.env.GOOGLE_CLOUD_PROJECT).toBe("gemini-project");
      expect(result.env.GOOGLE_CLOUD_LOCATION).toBe("us-west1");
    });
  });

  describe("getAgentCredentials - Other agents", () => {
    it("injects GITHUB_TOKEN for Copilot", async () => {
      vi.mocked(retrieveSecretWithFallback).mockImplementation(
        async (name: string): Promise<string> => {
          if (name === "GITHUB_TOKEN") return "ghp_test_token";
          throw new Error("Secret not found");
        },
      );

      const result = await getAgentCredentials("copilot", "workspace-1", "user-1");

      expect(result.env.GITHUB_TOKEN).toBe("ghp_test_token");
    });

    it("injects GROQ_API_KEY for Groq", async () => {
      vi.mocked(retrieveSecretWithFallback).mockImplementation(
        async (name: string): Promise<string> => {
          if (name === "GROQ_API_KEY") return "groq-key-123";
          throw new Error("Secret not found");
        },
      );

      const result = await getAgentCredentials("groq", "workspace-1", "user-1");

      expect(result.env.GROQ_API_KEY).toBe("groq-key-123");
    });

    it("injects OPENCLAW_API_KEY for OpenClaw", async () => {
      vi.mocked(retrieveSecretWithFallback).mockImplementation(
        async (name: string): Promise<string> => {
          if (name === "OPENCLAW_API_KEY") return "openclaw-key-123";
          throw new Error("Secret not found");
        },
      );

      const result = await getAgentCredentials("openclaw", "workspace-1", "user-1");

      expect(result.env.OPENCLAW_API_KEY).toBe("openclaw-key-123");
    });

    it("configures OpenCode defaults", async () => {
      vi.mocked(retrieveSecretWithFallback).mockImplementation(
        async (name: string): Promise<string> => {
          if (name === "OPENCODE_DEFAULT_BASE_URL") return "https://opencode.example.com";
          if (name === "OPENCODE_DEFAULT_MODEL") return "gpt-4";
          throw new Error("Secret not found");
        },
      );

      const result = await getAgentCredentials("opencode", "workspace-1", "user-1");

      expect(result.env.OPENCODE_DEFAULT_BASE_URL).toBe("https://opencode.example.com");
      expect(result.env.OPENCODE_DEFAULT_MODEL).toBe("gpt-4");
    });
  });
});
