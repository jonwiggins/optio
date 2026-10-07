import { describe, expect, it } from "vitest";
import { buildPooledAgentCommand } from "./pooled-agent-command.js";

const opts = { maxTurns: 10, label: "job" };
const runLine = (env: Record<string, string>) =>
  buildPooledAgentCommand("opencode", env, opts).find((l) => l.includes("opencode run"));

describe("buildPooledAgentCommand — opencode", () => {
  it("closes stdin so `opencode run` does not wait for EOF on the exec pipe", () => {
    expect(runLine({ OPTIO_PROMPT: "hi" })).toBe(
      'opencode run --format json "$OPTIO_PROMPT" </dev/null',
    );
  });

  it("passes the model and agent as flags", () => {
    expect(
      runLine({
        OPTIO_PROMPT: "hi",
        OPTIO_OPENCODE_MODEL: "openai/gpt-4.1",
        OPTIO_OPENCODE_AGENT: "build",
      }),
    ).toBe(
      'opencode run --format json --model "openai/gpt-4.1" --agent "build" "$OPTIO_PROMPT" </dev/null',
    );
  });
});

describe("buildPooledAgentCommand — codex", () => {
  it("signs in through a picked app-server instead of a key", () => {
    const lines = buildPooledAgentCommand(
      "codex",
      {
        OPTIO_PROMPT: "hi",
        OPTIO_CODEX_AUTH_MODE: "app-server",
        OPTIO_CODEX_APP_SERVER_URL: "http://as:1455",
      },
      opts,
    );
    expect(lines.find((l) => l.startsWith("codex exec"))).toContain(
      '--app-server "http://as:1455"',
    );
  });

  it("passes no app-server flag otherwise", () => {
    const lines = buildPooledAgentCommand("codex", { OPTIO_PROMPT: "hi" }, opts);
    expect(lines.find((l) => l.startsWith("codex exec"))).not.toContain("--app-server");
  });
});
