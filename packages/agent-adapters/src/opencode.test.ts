import { describe, it, expect } from "vitest";
import { OpenCodeAdapter } from "./opencode.js";

const adapter = new OpenCodeAdapter();

describe("OpenCodeAdapter", () => {
  describe("type and displayName", () => {
    it("has correct type", () => {
      expect(adapter.type).toBe("opencode");
    });

    it("has correct displayName", () => {
      expect(adapter.displayName).toBe("OpenCode");
    });
  });

  describe("validateSecrets", () => {
    it("returns valid when ANTHROPIC_API_KEY is present", () => {
      const result = adapter.validateSecrets(["ANTHROPIC_API_KEY"]);
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("returns valid when OPENAI_API_KEY is present", () => {
      const result = adapter.validateSecrets(["OPENAI_API_KEY"]);
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("returns valid when GROQ_API_KEY is present", () => {
      const result = adapter.validateSecrets(["GROQ_API_KEY"]);
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("reports missing when no provider keys are present", () => {
      const result = adapter.validateSecrets([]);
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(["ANTHROPIC_API_KEY or OPENAI_API_KEY"]);
    });

    it("reports missing when only unrelated secrets are present", () => {
      const result = adapter.validateSecrets(["GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"]);
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(["ANTHROPIC_API_KEY or OPENAI_API_KEY"]);
    });
  });

  describe("buildContainerConfig", () => {
    const baseInput = {
      taskId: "test-123",
      prompt: "Fix the bug",
      repoUrl: "https://github.com/org/repo",
      repoBranch: "main",
    };

    it("does not set extra workaround env vars — the stdin EOF fix is the only change", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.env.OPENCODE_DISABLE_MODELS_FETCH).toBeUndefined();
      expect(config.env.OPENCODE_DISABLE_AUTOUPDATE).toBeUndefined();
    });

    it("uses rendered prompt when available", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        renderedPrompt: "Rendered: Fix the bug",
      });
      expect(config.env.OPTIO_PROMPT).toBe("Rendered: Fix the bug");
    });

    it("falls back to raw prompt when no rendered prompt", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.env.OPTIO_PROMPT).toBe("Fix the bug");
    });

    it("sets correct env vars", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.env.OPTIO_TASK_ID).toBe("test-123");
      expect(config.env.OPTIO_AGENT_TYPE).toBe("opencode");
      expect(config.env.OPTIO_BRANCH_NAME).toBe("optio/task-test-123");
      expect(config.env.OPTIO_REPO_URL).toBe("https://github.com/org/repo");
      expect(config.env.OPTIO_REPO_BRANCH).toBe("main");
    });

    it("requires provider API key secrets", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.requiredSecrets).toContain("ANTHROPIC_API_KEY");
      expect(config.requiredSecrets).toContain("OPENAI_API_KEY");
    });

    it("sets OPTIO_OPENCODE_MODEL when opencodeModel is provided", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        opencodeModel: "anthropic/claude-sonnet-4",
      });
      expect(config.env.OPTIO_OPENCODE_MODEL).toBe("anthropic/claude-sonnet-4");
    });

    it("sets OPTIO_OPENCODE_AGENT when opencodeAgent is provided", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        opencodeAgent: "build",
      });
      expect(config.env.OPTIO_OPENCODE_AGENT).toBe("build");
    });

    it("does not set OPTIO_OPENCODE_MODEL or OPTIO_OPENCODE_AGENT when not provided", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.env.OPTIO_OPENCODE_MODEL).toBeUndefined();
      expect(config.env.OPTIO_OPENCODE_AGENT).toBeUndefined();
    });

    it("sets OPENAI_BASE_URL when opencodeBaseUrl is provided", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        opencodeBaseUrl: "http://lightllm-server:8080/v1",
      });
      expect(config.env.OPENAI_BASE_URL).toBe("http://lightllm-server:8080/v1");
    });

    it("sets placeholder OPENAI_API_KEY when opencodeBaseUrl is provided", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        opencodeBaseUrl: "http://localhost:8080/v1",
      });
      expect(config.env.OPENAI_API_KEY).toBe("sk-no-key-required");
    });

    it("does not require provider API key secrets when opencodeBaseUrl is set", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        opencodeBaseUrl: "http://localhost:8080/v1",
      });
      expect(config.requiredSecrets).not.toContain("ANTHROPIC_API_KEY");
      expect(config.requiredSecrets).not.toContain("OPENAI_API_KEY");
    });

    it("does not set OPENAI_BASE_URL when opencodeBaseUrl is not provided", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.env.OPENAI_BASE_URL).toBeUndefined();
    });

    it("includes opencode config as setup file", () => {
      const config = adapter.buildContainerConfig(baseInput);
      const configFile = config.setupFiles?.find((f) =>
        f.path.includes(".config/opencode/opencode.json"),
      );
      expect(configFile).toBeDefined();
      expect(JSON.parse(configFile!.content)).toEqual({
        $schema: "https://opencode.ai/config.json",
        permission: {
          "*": "allow",
          question: "deny",
          bash: {
            "sudo *": "deny",
            "apt *": "deny",
            "apt-get *": "deny",
            "dpkg *": "deny",
          },
          external_directory: {
            "*": "deny",
            "/home/agent/.local/share/opencode/**": "allow",
          },
        },
      });
    });

    it("includes task file in setup files when provided", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        taskFileContent: "# Task\nDo something",
        taskFilePath: ".optio/task.md",
      });
      const taskFile = config.setupFiles?.find((f) => f.path === ".optio/task.md");
      expect(taskFile).toBeDefined();
      expect(taskFile!.content).toBe("# Task\nDo something");
    });

    it("returns only opencode config in setupFiles when no task file", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.setupFiles).toHaveLength(3);
      expect(config.setupFiles![0].path).toContain("opencode.json");
      expect(config.setupFiles!.map((f) => f.path)).toContain(
        "/home/agent/.config/opencode/plugins/optio-workspace-guard.js",
      );
      expect(config.setupFiles!.map((f) => f.path)).toContain(
        "/home/agent/.config/opencode/AGENTS.md",
      );
    });

    it("uses entrypoint.sh as command", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.command).toEqual(["/opt/optio/entrypoint.sh"]);
    });

    describe("workspace confinement (headless guard)", () => {
      const readConfig = (setupFiles: { path: string; content: string }[]) => {
        const configFile = setupFiles.find((f) =>
          f.path.includes(".config/opencode/opencode.json"),
        );
        return JSON.parse(configFile!.content) as {
          permission?: Record<string, string | Record<string, string>>;
        };
      };

      const expectedPermission = {
        "*": "allow",
        question: "deny",
        bash: {
          "sudo *": "deny",
          "apt *": "deny",
          "apt-get *": "deny",
          "dpkg *": "deny",
        },
        external_directory: {
          "*": "deny",
          "/home/agent/.local/share/opencode/**": "allow",
        },
      };

      it("allows everything by default", () => {
        const config = adapter.buildContainerConfig(baseInput);
        const parsed = readConfig(config.setupFiles!);
        expect(parsed.permission?.["*"]).toBe("allow");
      });

      it("denies the question tool so headless runs never ask", () => {
        const config = adapter.buildContainerConfig(baseInput);
        const parsed = readConfig(config.setupFiles!);
        expect(parsed.permission?.["question"]).toBe("deny");
      });

      it("denies system package installs and privilege escalation via bash", () => {
        const config = adapter.buildContainerConfig(baseInput);
        const parsed = readConfig(config.setupFiles!);
        expect(parsed.permission?.["bash"]).toEqual(expectedPermission.bash);
      });

      it("denies external_directory so the agent stays inside the worktree", () => {
        const config = adapter.buildContainerConfig(baseInput);
        const parsed = readConfig(config.setupFiles!);
        expect(parsed.permission?.["external_directory"]).toMatchObject({ "*": "deny" });
      });

      it("keeps opencode's own tool-output directory accessible", () => {
        const config = adapter.buildContainerConfig(baseInput);
        const parsed = readConfig(config.setupFiles!);
        expect(parsed.permission?.["external_directory"]).toMatchObject({
          "/home/agent/.local/share/opencode/**": "allow",
        });
      });

      it("ships the workspace-guard plugin as a global setup file", () => {
        const config = adapter.buildContainerConfig(baseInput);
        const plugin = config.setupFiles?.find(
          (f) => f.path === "/home/agent/.config/opencode/plugins/optio-workspace-guard.js",
        );
        expect(plugin).toBeDefined();
        expect(plugin!.content).toContain("tool.execute.before");
      });

      it("plugin hint tells the agent to stay inside the workspace", () => {
        const config = adapter.buildContainerConfig(baseInput);
        const plugin = config.setupFiles?.find(
          (f) => f.path === "/home/agent/.config/opencode/plugins/optio-workspace-guard.js",
        );
        expect(plugin!.content).toContain("Im Workspace bleiben");
      });

      it("plugin blocks /tmp but allows opencode internals", () => {
        const config = adapter.buildContainerConfig(baseInput);
        const plugin = config.setupFiles?.find(
          (f) => f.path === "/home/agent/.config/opencode/plugins/optio-workspace-guard.js",
        );
        expect(plugin!.content).toContain('"bash"');
        expect(plugin!.content).toContain("/tmp");
        expect(plugin!.content).toContain(".local/share/opencode");
      });

      it("ships global AGENTS.md workspace rules", () => {
        const config = adapter.buildContainerConfig(baseInput);
        const agents = config.setupFiles?.find(
          (f) => f.path === "/home/agent/.config/opencode/AGENTS.md",
        );
        expect(agents).toBeDefined();
        expect(agents!.content).toContain("workspace");
        expect(agents!.content).toContain("headless");
      });

      it("writes the same guard files for litellm-based runs", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          opencodeBaseUrl: "http://litellm-proxy:4000",
          opencodeModel: "litellm/default",
        });
        const paths = config.setupFiles!.map((f) => f.path);
        expect(paths).toContain("/home/agent/.config/opencode/plugins/optio-workspace-guard.js");
        expect(paths).toContain("/home/agent/.config/opencode/AGENTS.md");
      });
    });

    describe("Native Provider (Anthropic/OpenAI/Groq)", () => {
      it("Native Anthropic: only ANTHROPIC_API_KEY set → minimal opencode.json", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          opencodeModel: undefined,
          opencodeBaseUrl: undefined,
        });
        const configFile = config.setupFiles!.find((f) => f.path.includes("opencode.json"));
        expect(configFile).toBeDefined();
        expect(JSON.parse(configFile!.content)).toEqual({
          $schema: "https://opencode.ai/config.json",
          permission: {
            "*": "allow",
            question: "deny",
            bash: {
              "sudo *": "deny",
              "apt *": "deny",
              "apt-get *": "deny",
              "dpkg *": "deny",
            },
            external_directory: {
              "*": "deny",
              "/home/agent/.local/share/opencode/**": "allow",
            },
          },
        });
        expect(config.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(config.env.OPENAI_API_KEY).toBeUndefined();
        expect(config.requiredSecrets).toContain("ANTHROPIC_API_KEY");
      });

      it("Native Anthropic: ANTHROPIC_API_KEY + OPENCODE_DEFAULT_MODEL set", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          opencodeModel: undefined,
          opencodeBaseUrl: undefined,
          opencodeDefaultModel: "claude-sonnet-4",
        });
        expect(config.env.OPENCODE_MODEL).toBe("claude-sonnet-4");
        expect(config.requiredSecrets).toContain("ANTHROPIC_API_KEY");
      });

      it("Native OpenAI: only OPENAI_API_KEY set", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          opencodeModel: undefined,
          opencodeBaseUrl: undefined,
        });
        const configFile = config.setupFiles!.find((f) => f.path.includes("opencode.json"));
        expect(JSON.parse(configFile!.content)).toEqual({
          $schema: "https://opencode.ai/config.json",
          permission: {
            "*": "allow",
            question: "deny",
            bash: {
              "sudo *": "deny",
              "apt *": "deny",
              "apt-get *": "deny",
              "dpkg *": "deny",
            },
            external_directory: {
              "*": "deny",
              "/home/agent/.local/share/opencode/**": "allow",
            },
          },
        });
        expect(config.env.OPENAI_API_KEY).toBeUndefined();
        expect(config.requiredSecrets).toContain("OPENAI_API_KEY");
      });

      it("Native OpenAI: OPENAI_API_KEY (emptystring) + OPENCODE_DEFAULT_MODEL set", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          opencodeModel: undefined,
          opencodeBaseUrl: undefined,
          opencodeDefaultModel: "gpt-4o",
        });
        expect(config.env.OPENCODE_MODEL).toBe("gpt-4o");
        expect(config.requiredSecrets).toContain("OPENAI_API_KEY");
      });

      it("Native OpenAI: OPENAI_API_KEY + OPENCODE_DEFAULT_MODEL set", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          opencodeModel: undefined,
          opencodeBaseUrl: undefined,
          opencodeDefaultModel: "gpt-4o",
        });
        expect(config.env.OPENCODE_MODEL).toBe("gpt-4o");
        expect(config.requiredSecrets).toContain("OPENAI_API_KEY");
      });

      it("Native Groq: only GROQ_API_KEY set", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          opencodeModel: undefined,
          opencodeBaseUrl: undefined,
        });
        const configFile = config.setupFiles!.find((f) => f.path.includes("opencode.json"));
        expect(JSON.parse(configFile!.content)).toEqual({
          $schema: "https://opencode.ai/config.json",
          permission: {
            "*": "allow",
            question: "deny",
            bash: {
              "sudo *": "deny",
              "apt *": "deny",
              "apt-get *": "deny",
              "dpkg *": "deny",
            },
            external_directory: {
              "*": "deny",
              "/home/agent/.local/share/opencode/**": "allow",
            },
          },
        });
        expect(config.env.GROQ_API_KEY).toBeUndefined();
        expect(config.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(config.env.OPENAI_API_KEY).toBeUndefined();
      });

      it("Native Groq: GROQ_API_KEY + OPENCODE_DEFAULT_MODEL set", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          opencodeModel: undefined,
          opencodeBaseUrl: undefined,
          opencodeDefaultModel: "llama-3.1-70b",
        });
        expect(config.env.OPENCODE_MODEL).toBe("llama-3.1-70b");
      });

      it("Native Anthropic: multiple provider keys set (ANTHROPIC_API_KEY + OPENAI_API_KEY)", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          opencodeModel: undefined,
          opencodeBaseUrl: undefined,
        });
        expect(config.requiredSecrets).toContain("ANTHROPIC_API_KEY");
        expect(config.requiredSecrets).toContain("OPENAI_API_KEY");
      });
    });

    describe("LiteLLM Provider", () => {
      it("LiteLLM: URL + Model, WITHOUT OPENAI_API_KEY secret → placeholder key", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          opencodeBaseUrl: "http://litellm-proxy.agents.svc.cluster.local:4000",
          opencodeModel: "litellm/my-litellm-model",
          opencodeDefaultModel: undefined,
        });
        const configFile = config.setupFiles!.find((f) => f.path.includes("opencode.json"));
        expect(configFile).toBeDefined();
        const parsedConfig = JSON.parse(configFile!.content);
        expect(parsedConfig).toEqual({
          $schema: "https://opencode.ai/config.json",
          model: "litellm/my-litellm-model",
          permission: {
            "*": "allow",
            question: "deny",
            bash: {
              "sudo *": "deny",
              "apt *": "deny",
              "apt-get *": "deny",
              "dpkg *": "deny",
            },
            external_directory: {
              "*": "deny",
              "/home/agent/.local/share/opencode/**": "allow",
            },
          },
          provider: {
            litellm: {
              npm: "@ai-sdk/openai-compatible",
              name: "LiteLLM Proxy",
              options: {
                baseURL: "http://litellm-proxy.agents.svc.cluster.local:4000",
                apiKey: "{env:OPENAI_API_KEY}",
              },
              models: {
                "my-litellm-model": {
                  name: "my-litellm-model",
                },
              },
            },
          },
        });
        expect(config.env.OPENAI_API_KEY).toBe("sk-no-key-required");
        expect(config.env.OPENCODE_MODEL).toBe("litellm/my-litellm-model");
        expect(config.env.OPENAI_BASE_URL).toBeUndefined();
        expect(config.requiredSecrets).toContain("OPENAI_API_KEY");
      });

      it("LiteLLM: URL + Model, WITH OPENAI_API_KEY secret", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          opencodeBaseUrl: "http://litellm-proxy.agents.svc.cluster.local:4000",
          opencodeModel: "litellm/my-litellm-model",
          opencodeDefaultModel: undefined,
        });
        const configFile = config.setupFiles!.find((f) => f.path.includes("opencode.json"));
        const parsedConfig = JSON.parse(configFile!.content);
        expect(parsedConfig.provider.litellm.options.baseURL).toBe(
          "http://litellm-proxy.agents.svc.cluster.local:4000",
        );
        expect(parsedConfig.provider.litellm.options.apiKey).toBe("{env:OPENAI_API_KEY}");
        expect(parsedConfig.model).toBe("litellm/my-litellm-model");
        expect(config.env.OPENCODE_MODEL).toBe("litellm/my-litellm-model");
        expect(config.env.OPENAI_BASE_URL).toBeUndefined();
        expect(config.requiredSecrets).toContain("OPENAI_API_KEY");
      });

      it("LiteLLM: fallback to OPENCODE_DEFAULT_MODEL when opencodeModel not set", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          opencodeBaseUrl: "http://litellm-proxy:4000",
          opencodeModel: undefined,
          opencodeDefaultModel: "litellm/litellm-default-model",
        });
        const configFile = config.setupFiles!.find((f) => f.path.includes("opencode.json"));
        const parsedConfig = JSON.parse(configFile!.content);
        expect(parsedConfig.model).toBe("litellm/litellm-default-model");
        expect(parsedConfig.provider.litellm.models).toEqual({
          "litellm-default-model": { name: "litellm-default-model" },
        });
        expect(config.env.OPENCODE_MODEL).toBe("litellm/litellm-default-model");
      });

      it("LiteLLM: opencodeModel wins over OPENCODE_DEFAULT_MODEL when both set", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          opencodeBaseUrl: "http://litellm-proxy:4000",
          opencodeModel: "litellm/repo-specific-model",
          opencodeDefaultModel: "global-secret-model",
        });
        const configFile = config.setupFiles!.find((f) => f.path.includes("opencode.json"));
        const parsedConfig = JSON.parse(configFile!.content);
        expect(parsedConfig.model).toBe("litellm/repo-specific-model");
        expect(parsedConfig.provider.litellm.models).toEqual({
          "repo-specific-model": { name: "repo-specific-model" },
        });
        expect(config.env.OPENCODE_MODEL).toBe("litellm/repo-specific-model");
      });
    });

    describe("Native Provider: Model Priority", () => {
      it("Native: opencodeModel wins over OPENCODE_DEFAULT_MODEL when both set", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          opencodeModel: "anthropic/claude-opus-4",
          opencodeDefaultModel: "claude-sonnet-4",
        });
        expect(config.env.OPENCODE_MODEL).toBe("anthropic/claude-opus-4");
        expect(config.env.OPTIO_OPENCODE_MODEL).toBe("anthropic/claude-opus-4");
      });
    });

    describe("Secret Injection Verification", () => {
      it("OPENAI_API_KEY secret resolves to container env var", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          opencodeBaseUrl: "http://litellm-proxy:4000/v1",
          opencodeModel: "litellm/test-model",
        });
        expect(config.requiredSecrets).toContain("OPENAI_API_KEY");
      });

      it("Missing OPENAI_API_KEY secret results in fallback placeholder", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          opencodeBaseUrl: "http://litellm-proxy:4000/v1",
        });
        expect(config.env.OPENAI_API_KEY).toBe("sk-no-key-required");
      });
    });
  });

  describe("parseResult", () => {
    it("returns success for exit code 0 with no errors", () => {
      const result = adapter.parseResult(0, "some output\nmore output");
      expect(result.success).toBe(true);
      expect(result.summary).toBe("Agent completed successfully");
      expect(result.error).toBeUndefined();
    });

    it("returns failure for non-zero exit code", () => {
      const result = adapter.parseResult(1, "some output");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Exit code: 1");
    });

    it("extracts GitHub PR URL from logs", () => {
      const logs = `Working on task...\nhttps://github.com/org/repo/pull/42\nDone!`;
      const result = adapter.parseResult(0, logs);
      expect(result.prUrl).toBe("https://github.com/org/repo/pull/42");
    });

    it("extracts GitLab MR URL from logs", () => {
      const logs = `Working on task...\nhttps://gitlab.com/org/repo/-/merge_requests/7\nDone!`;
      const result = adapter.parseResult(0, logs);
      expect(result.prUrl).toBe("https://gitlab.com/org/repo/-/merge_requests/7");
    });

    it("extracts summary from last assistant message", () => {
      const logs = [
        '{"type":"message","role":"assistant","content":"Starting work"}',
        '{"type":"message","role":"assistant","content":"All done, PR created"}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      expect(result.summary).toBe("All done, PR created");
    });

    it("extracts summary from result event", () => {
      const logs = '{"type":"result","result":"Task completed successfully"}';
      const result = adapter.parseResult(0, logs);
      expect(result.summary).toBe("Task completed successfully");
    });

    it("truncates long summaries", () => {
      const longMsg = "x".repeat(300);
      const logs = `{"type":"message","role":"assistant","content":"${longMsg}"}`;
      const result = adapter.parseResult(0, logs);
      expect(result.summary!.length).toBeLessThanOrEqual(201); // 200 + ellipsis
    });

    it("uses total_cost_usd when provided directly", () => {
      const logs = '{"type":"result","total_cost_usd":0.0534}';
      const result = adapter.parseResult(0, logs);
      expect(result.costUsd).toBe(0.0534);
    });

    it("leaves cost undefined when not provided", () => {
      const logs = '{"type":"message","role":"assistant","content":"Done"}';
      const result = adapter.parseResult(0, logs);
      expect(result.costUsd).toBeUndefined();
    });

    it("detects error events in JSON output", () => {
      const logs = '{"type":"error","message":"Provider API key is invalid"}';
      const result = adapter.parseResult(0, logs);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Provider API key is invalid");
    });

    it("detects error envelope in JSON output", () => {
      const logs =
        '{"error":{"message":"Invalid API key","type":"auth_error","code":"invalid_key"}}';
      const result = adapter.parseResult(0, logs);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid API key");
    });

    it("detects is_error result events", () => {
      const logs = '{"is_error":true,"result":"Authentication failed"}';
      const result = adapter.parseResult(0, logs);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Authentication failed");
    });

    it("extracts token usage from events", () => {
      const logs = [
        '{"type":"message","role":"assistant","content":"Done","usage":{"input_tokens":1000,"output_tokens":500}}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(500);
    });

    it("includes cache_read and cache_creation tokens in input total", () => {
      const logs =
        '{"type":"message","role":"assistant","content":"Done","usage":{"input_tokens":50,"output_tokens":200,"cache_creation_input_tokens":1000,"cache_read_input_tokens":5000}}';
      const result = adapter.parseResult(0, logs);
      expect(result.inputTokens).toBe(6050);
      expect(result.outputTokens).toBe(200);
    });

    it("extracts token usage from OpenAI-style naming", () => {
      const logs =
        '{"type":"message","role":"assistant","content":"Done","usage":{"prompt_tokens":2000,"completion_tokens":1000}}';
      const result = adapter.parseResult(0, logs);
      expect(result.inputTokens).toBe(2000);
      expect(result.outputTokens).toBe(1000);
    });

    it("extracts model from events", () => {
      const logs =
        '{"model":"anthropic/claude-sonnet-4","type":"message","role":"assistant","content":"Hi"}';
      const result = adapter.parseResult(0, logs);
      expect(result.model).toBe("anthropic/claude-sonnet-4");
    });

    it("detects auth errors in raw text", () => {
      const logs = "Error: ANTHROPIC_API_KEY authentication failed";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("ANTHROPIC_API_KEY");
    });

    it("detects model not found errors in raw text", () => {
      const logs = "Error: model_not_found - The model does not exist";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("model_not_found");
    });

    it("detects server errors in raw text", () => {
      const logs = "Error: 503 service unavailable";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("503");
    });

    it("handles empty logs gracefully", () => {
      const result = adapter.parseResult(0, "");
      expect(result.success).toBe(true);
      expect(result.costUsd).toBeUndefined();
      expect(result.inputTokens).toBeUndefined();
      expect(result.outputTokens).toBeUndefined();
      expect(result.model).toBeUndefined();
    });

    it("does not compute cost from tokens (provider-agnostic)", () => {
      const logs =
        '{"type":"message","role":"assistant","content":"Done","usage":{"input_tokens":1000,"output_tokens":500}}';
      const result = adapter.parseResult(0, logs);
      // OpenCode is provider-agnostic — no per-token cost calculation
      expect(result.costUsd).toBeUndefined();
    });
  });
});
