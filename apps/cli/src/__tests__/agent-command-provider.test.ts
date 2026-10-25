import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  GATEWAY_CLAUDE_SETTINGS,
  buildAgentCommand,
  gatewaySettingsPath,
} from "../local/agent-command.js";
import { writeClaudeHookSettings } from "../local/hook-server.js";
import { listAwsProfiles } from "../local/aws-profiles.js";

const SETTINGS = "/home/u/.config/optio/local/claude-hooks.json";
const CLAUDE = `claude --settings '${SETTINGS}' --dangerously-skip-permissions`;
const GATEWAY_SETTINGS = "/home/u/.config/optio/local/claude-gateway.json";
const GATEWAY_CLAUDE = `claude --settings '${GATEWAY_SETTINGS}' --dangerously-skip-permissions`;

describe("buildAgentCommand with a model provider", () => {
  it("runs Claude Code on Bedrock with the machine's AWS profile, dropping exported keys", () => {
    expect(
      buildAgentCommand("claude-code", "hi", SETTINGS, {
        model: "us.anthropic.claude-opus-5-5",
        provider: { region: "us-west-2", awsProfile: "bedrock" },
      }),
    ).toBe(
      "env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u AWS_BEARER_TOKEN_BEDROCK " +
        "AWS_REGION='us-west-2' AWS_DEFAULT_REGION='us-west-2' AWS_PROFILE='bedrock' CLAUDE_CODE_USE_BEDROCK='1' " +
        `${CLAUDE} --model 'us.anthropic.claude-opus-5-5' 'hi'`,
    );
  });

  it("uses the default AWS credentials when no profile is named", () => {
    const cmd = buildAgentCommand("claude-code", undefined, SETTINGS, {
      provider: { region: "eu-west-1" },
    });
    expect(cmd).toBe(
      `env AWS_REGION='eu-west-1' AWS_DEFAULT_REGION='eu-west-1' CLAUDE_CODE_USE_BEDROCK='1' ${CLAUDE}`,
    );
  });

  it("points Codex at its amazon-bedrock provider, also on a headless resume", () => {
    expect(
      buildAgentCommand("codex", "go", SETTINGS, {
        model: "openai.gpt-5.4",
        provider: { region: "us-west-2" },
      }),
    ).toBe(
      "env AWS_REGION='us-west-2' AWS_DEFAULT_REGION='us-west-2' " +
        `codex --dangerously-bypass-approvals-and-sandbox -m 'openai.gpt-5.4' -c 'model_provider="amazon-bedrock"' 'go'`,
    );
    expect(
      buildAgentCommand("codex", undefined, SETTINGS, {
        mode: "headless",
        resumeSessionId: "abc",
        provider: { region: "us-west-2" },
      }),
    ).toContain(
      `codex exec resume --dangerously-bypass-approvals-and-sandbox -c 'model_provider="amazon-bedrock"' 'abc'`,
    );
  });

  it("ignores a provider for agents it can't serve", () => {
    expect(buildAgentCommand("gemini", "x", SETTINGS, { provider: { region: "us-west-2" } })).toBe(
      `gemini -i 'x'`,
    );
  });

  it("quotes a hostile region instead of running it", () => {
    const cmd = buildAgentCommand("claude-code", undefined, SETTINGS, {
      provider: { region: "x'; rm -rf / #" },
    });
    expect(cmd).toContain(`AWS_REGION='x'\\''; rm -rf / #'`);
  });
});

describe("buildAgentCommand with the model gateway", () => {
  const gateway = {
    kind: "gateway" as const,
    region: "",
    env: {
      ANTHROPIC_BASE_URL: "https://litellm.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-person",
      ANTHROPIC_MODEL: "acme-coder-large",
    },
  };

  it("runs Claude Code with the gateway's env, dropping the machine's own key and OAuth token", () => {
    expect(
      buildAgentCommand("claude-code", "hi", SETTINGS, {
        model: "acme-coder-large",
        effort: "high",
        provider: gateway,
      }),
    ).toBe(
      "env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN " +
        "ANTHROPIC_BASE_URL='https://litellm.example.com' ANTHROPIC_AUTH_TOKEN='sk-person' ANTHROPIC_MODEL='acme-coder-large' " +
        `${GATEWAY_CLAUDE} --model 'acme-coder-large' --effort 'high' 'hi'`,
    );
  });

  it("gives a gateway spawn the settings file with no WebFetch preflight, and no other spawn", () => {
    expect(gatewaySettingsPath(SETTINGS)).toBe(GATEWAY_SETTINGS);
    expect(buildAgentCommand("claude-code", "hi", SETTINGS, { provider: gateway })).toContain(
      `--settings '${GATEWAY_SETTINGS}'`,
    );
    // Bedrock and no provider keep the plain hooks file.
    expect(
      buildAgentCommand("claude-code", "hi", SETTINGS, { provider: { region: "us-west-2" } }),
    ).toContain(`--settings '${SETTINGS}'`);
    expect(buildAgentCommand("claude-code", "hi", SETTINGS)).toContain(`--settings '${SETTINGS}'`);
  });

  it("writes the gateway file as the hooks file plus skipWebFetchPreflight", () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-hooks-"));
    const hooksPath = join(dir, "claude-hooks.json");
    writeClaudeHookSettings(hooksPath);
    writeClaudeHookSettings(gatewaySettingsPath(hooksPath), GATEWAY_CLAUDE_SETTINGS);
    const plain = JSON.parse(readFileSync(hooksPath, "utf-8"));
    const gw = JSON.parse(readFileSync(join(dir, "claude-gateway.json"), "utf-8"));
    expect(plain.skipWebFetchPreflight).toBeUndefined();
    expect(gw.skipWebFetchPreflight).toBe(true);
    expect(gw.hooks).toEqual(plain.hooks);
    expect(Object.keys(gw.hooks)).toEqual(["Stop", "Notification", "UserPromptSubmit"]);
  });

  it("keeps the machine's key when the gateway takes the token as ANTHROPIC_API_KEY", () => {
    const cmd = buildAgentCommand("claude-code", undefined, SETTINGS, {
      provider: {
        ...gateway,
        env: { ANTHROPIC_BASE_URL: "https://litellm.example.com", ANTHROPIC_API_KEY: "sk-key" },
      },
    });
    expect(cmd.startsWith("env -u CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_BASE_URL=")).toBe(true);
    expect(cmd).not.toContain("-u ANTHROPIC_API_KEY");
    expect(cmd).toContain("ANTHROPIC_API_KEY='sk-key'");
  });

  it("points OpenCode at the gateway's OpenAI-compatible endpoint", () => {
    expect(
      buildAgentCommand("opencode", "go", SETTINGS, {
        mode: "headless",
        model: "acme-coder-large",
        provider: {
          kind: "gateway",
          region: "",
          env: {
            OPENAI_BASE_URL: "https://litellm.example.com/v1",
            OPENAI_API_KEY: "sk-person",
          },
        },
      }),
    ).toBe(
      "env OPENAI_BASE_URL='https://litellm.example.com/v1' OPENAI_API_KEY='sk-person' " +
        `opencode run --model 'acme-coder-large' 'go'`,
    );
  });

  it("ignores a gateway for agents it can't serve, never treating it as Bedrock", () => {
    expect(buildAgentCommand("codex", "x", SETTINGS, { provider: gateway })).toBe(
      `codex --dangerously-bypass-approvals-and-sandbox 'x'`,
    );
    expect(buildAgentCommand("gemini", "x", SETTINGS, { provider: gateway })).toBe(`gemini -i 'x'`);
  });

  it("quotes a hostile token instead of running it", () => {
    const cmd = buildAgentCommand("claude-code", undefined, SETTINGS, {
      provider: { ...gateway, env: { ANTHROPIC_AUTH_TOKEN: "x'; rm -rf / #" } },
    });
    expect(cmd).toContain(`ANTHROPIC_AUTH_TOKEN='x'\\''; rm -rf / #'`);
  });
});

describe("listAwsProfiles", () => {
  it("reads profile names (never keys) from the config and credentials files", () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-"));
    mkdirSync(join(dir, ".aws"));
    writeFileSync(
      join(dir, ".aws", "config"),
      "[default]\nregion = us-west-2\n[profile bedrock]\nsso_session = x\n[sso-session x]\n",
    );
    writeFileSync(
      join(dir, ".aws", "credentials"),
      "[ci]\naws_access_key_id = AKIA...\n[default]\n",
    );
    expect(listAwsProfiles({ HOME: dir })).toEqual(["bedrock", "ci", "default"]);
  });

  it("is empty without an AWS setup", () => {
    expect(listAwsProfiles({ HOME: mkdtempSync(join(tmpdir(), "aws-none-")) })).toEqual([]);
  });
});

describe("Claude Code effort levels", () => {
  const caps = { permissionModes: null, effort: true, effortLevels: ["low", "medium", "high"] };
  it("passes an effort this claude lists, and leaves out one it doesn't", () => {
    expect(
      buildAgentCommand("claude-code", undefined, SETTINGS, { effort: "high", claudeCaps: caps }),
    ).toBe(`${CLAUDE} --effort 'high'`);
    expect(
      buildAgentCommand("claude-code", undefined, SETTINGS, { effort: "max", claudeCaps: caps }),
    ).toBe(CLAUDE);
    // Unknown list: passed as asked.
    expect(buildAgentCommand("claude-code", undefined, SETTINGS, { effort: "max" })).toBe(
      `${CLAUDE} --effort 'max'`,
    );
  });
});
