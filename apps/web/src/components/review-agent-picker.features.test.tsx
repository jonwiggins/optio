import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
let features = featuresFromEnv({});
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ features, loaded: true }),
}));
vi.mock("@/lib/api-client", () => ({
  api: {
    getAgentProviderOptions: vi.fn().mockRejectedValue(new Error("offline")),
  },
}));
import { ReviewAgentPicker } from "./review-agent-picker";
afterEach(() => {
  cleanup();
  features = featuresFromEnv({});
});
function renderPicker(agentType: "codex" | null) {
  render(
    <ReviewAgentPicker
      agentType={agentType}
      model=""
      allowInherit
      onAgentTypeChange={vi.fn()}
      onModelChange={vi.fn()}
    />,
  );
  return Array.from((screen.getAllByRole("combobox")[0] as HTMLSelectElement).options).map(
    (o) => o.value,
  );
}
describe("review runtime allowlist", () => {
  it("offers only the configured agents", () => {
    features = featuresFromEnv({ OPTIO_RUNTIMES: "claude-code,opencode" });
    expect(renderPicker(null)).toEqual(["__inherit__", "claude-code", "opencode"]);
  });
  it("retains a saved agent outside the list", () => {
    features = featuresFromEnv({ OPTIO_RUNTIMES: "opencode" });
    expect(renderPicker("codex")).toEqual(["__inherit__", "opencode", "codex"]);
  });
  it("retains Pi in the default list", () => {
    expect(renderPicker(null)).toContain("pi");
  });
});
