import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkSpecSchema } from "./work.js";
import { AgentTypeSchema } from "./task.js";

const spec = (overrides: Record<string, unknown> = {}) => ({
  name: "Nightly",
  when: { type: "manual" },
  where: { runTarget: "cluster", repoUrl: "https://gitlab.example/acme/api" },
  who: { runtime: "claude-code" },
  what: { prompt: "Fix the build" },
  then: "until-merged",
  ...overrides,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("WorkSpecSchema", () => {
  it("refuses a runtime outside OPTIO_RUNTIMES; the default takes it", () => {
    vi.stubEnv("OPTIO_RUNTIMES", "claude-code,opencode");
    const refused = WorkSpecSchema.safeParse(spec({ who: { runtime: "codex" } }));
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0].message).toBe("codex isn't available in this deployment");
    expect(WorkSpecSchema.safeParse(spec({ who: { runtime: "opencode" } })).success).toBe(true);
    expect(WorkSpecSchema.safeParse(spec({ who: { runtime: null } })).success).toBe(true);

    vi.stubEnv("OPTIO_RUNTIMES", "");
    expect(WorkSpecSchema.safeParse(spec({ who: { runtime: "codex" } })).success).toBe(true);
  });
});

describe("AgentTypeSchema (task creation's agentType)", () => {
  it("refuses runtimes OPTIO_RUNTIMES leaves out and keeps upstream's enum by default", () => {
    vi.stubEnv("OPTIO_RUNTIMES", "claude-code,opencode");
    expect(AgentTypeSchema.safeParse("cursor").success).toBe(false);
    expect(AgentTypeSchema.safeParse("claude-code").success).toBe(true);
    vi.stubEnv("OPTIO_RUNTIMES", "");
    for (const r of [
      "claude-code",
      "codex",
      "copilot",
      "opencode",
      "gemini",
      "openclaw",
      "cursor",
    ]) {
      expect(AgentTypeSchema.safeParse(r).success).toBe(true);
    }
    expect(AgentTypeSchema.safeParse("made-up").success).toBe(false);
  });
});
