import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RUNTIMES } from "./agent-choice-model";

vi.mock("@/components/agent-options-picker", () => ({
  AgentOptionsPicker: () => <div />,
}));
let features = featuresFromEnv({});
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ features, loaded: true }),
}));
import { AgentChoice, ReviewAgentChoice } from "./agent-choice";
afterEach(() => {
  cleanup();
  features = featuresFromEnv({});
});
const choices = () =>
  Array.from(screen.getByRole("group").querySelectorAll("button")).map((b) => b.textContent);
function renderChoice(extra = {}) {
  render(
    <AgentChoice
      runtime="claude-code"
      agentOptions={{}}
      onRuntimeChange={vi.fn()}
      onOptionsChange={vi.fn()}
      {...extra}
    />,
  );
}
describe("agent runtime allowlists", () => {
  it("retains the upstream choices when unset", () => {
    renderChoice();
    expect(choices()).toHaveLength(RUNTIMES.length);
  });
  it("filters the default runtime list", () => {
    features = featuresFromEnv({ OPTIO_RUNTIMES: "claude-code,opencode" });
    renderChoice();
    expect(choices()).toEqual(["Claude Code", "OpenCode"]);
  });
  it("filters a caller's list while retaining Terminal", () => {
    features = featuresFromEnv({ OPTIO_RUNTIMES: "opencode" });
    renderChoice({ runtimes: [{ value: "" }, { value: "codex" }, { value: "opencode" }] });
    expect(choices()).toEqual(["Terminal", "OpenCode"]);
  });
  it("applies the same list to review agents", () => {
    features = featuresFromEnv({ OPTIO_RUNTIMES: "claude-code,opencode" });
    render(<ReviewAgentChoice agentType={null} model="" onChange={vi.fn()} />);
    expect(choices()).toEqual(["Repo default", "Claude Code", "OpenCode"]);
  });
});
