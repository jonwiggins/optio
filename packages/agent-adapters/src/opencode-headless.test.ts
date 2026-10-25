import { describe, expect, it } from "vitest";
import type { AgentTaskInput } from "@optio/shared";
import { OpenCodeAdapter } from "./opencode.js";
import {
  OPENCODE_AUTO_APPROVE_FLAG,
  OPENCODE_GLOBAL_AGENTS_MD,
  OPENCODE_GLOBAL_AGENTS_MD_PATH,
  opencodeHeadlessPermission,
} from "./opencode-headless.js";

// Upstream PR #585: a headless `opencode run` aborted with exit 1 when its
// external_directory ask (a venv under /tmp) had nobody to answer it.
const input: AgentTaskInput = {
  taskId: "t1",
  prompt: "Fix it",
  repoUrl: "https://gitlab.example.com/platform/my.service",
  repoBranch: "main",
};

describe("OpenCode headless permissions", () => {
  it("allows everything else, denies questions, outside paths and system packages", () => {
    expect(opencodeHeadlessPermission()).toEqual({
      "*": "allow",
      question: "deny",
      bash: { "sudo *": "deny", "apt *": "deny", "apt-get *": "deny", "dpkg *": "deny" },
      external_directory: {
        "*": "deny",
        "/home/agent/.local/share/opencode/**": "allow",
      },
    });
  });

  it("gives every call a fresh object (callers may merge into it)", () => {
    const a = opencodeHeadlessPermission();
    (a.bash as Record<string, string>)["rm *"] = "deny";
    expect(opencodeHeadlessPermission().bash).not.toHaveProperty("rm *");
  });

  it("is the flag OpenCode 1.14.20 calls auto-approve", () => {
    expect(OPENCODE_AUTO_APPROVE_FLAG).toBe("--dangerously-skip-permissions");
  });
});

describe("OpenCodeAdapter pre-seeded config", () => {
  const files = new OpenCodeAdapter().buildContainerConfig(input).setupFiles ?? [];

  it("writes the permissions into the global opencode.json", () => {
    const config = files.find((f) => f.path === "/home/agent/.config/opencode/opencode.json");
    expect(config).toBeDefined();
    expect(JSON.parse(config!.content)).toEqual({
      $schema: "https://opencode.ai/config.json",
      permission: opencodeHeadlessPermission(),
    });
  });

  it("writes the global AGENTS.md with the headless rules", () => {
    const rules = files.find((f) => f.path === OPENCODE_GLOBAL_AGENTS_MD_PATH);
    expect(rules?.content).toBe(OPENCODE_GLOBAL_AGENTS_MD);
    expect(rules?.content).toMatch(/Never ask one/);
    expect(rules?.content).toMatch(/Stay inside the workspace/);
    expect(rules?.content).toMatch(/No sudo/);
  });
});
