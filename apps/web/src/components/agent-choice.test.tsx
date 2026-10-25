import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

// The picker below the grid is the agent's own options; here only what it is handed matters.
const pickerProps = vi.fn();
vi.mock("@/components/agent-options-picker", () => ({
  AgentOptionsPicker: (props: Record<string, unknown>) => {
    pickerProps(props);
    return <div data-testid="options-picker" />;
  },
}));

const listModelProviders = vi.fn();
const getMyGateway = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    listModelProviders: (...a: unknown[]) => listModelProviders(...a),
    getMyGateway: (...a: unknown[]) => getMyGateway(...a),
  },
}));

let features = featuresFromEnv({});
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ features, gatewayOnly: features.modelAccess === "gateway", loaded: true }),
}));

import { AgentChoice, ReviewAgentChoice } from "./agent-choice";
import { resetDefaultGatewayCache } from "@/hooks/use-default-gateway";
import { useGatewayStore } from "@/hooks/use-gateway";

const GATEWAY = {
  id: "gw1",
  name: "LiteLLM",
  kind: "gateway",
  agents: ["claude-code"],
  ownerUserId: null,
  mine: false,
  models: { "claude-code": [{ id: "corp-opus", label: "Corp Opus" }] },
};

const buttons = (group: string) =>
  Array.from(screen.getByRole("group", { name: group }).querySelectorAll("button")).map(
    (b) => b.textContent,
  );

beforeEach(() => {
  pickerProps.mockReset();
  listModelProviders.mockReset().mockResolvedValue({ providers: [GATEWAY] });
  getMyGateway.mockReset().mockResolvedValue({ gateway: { id: "gw1", name: "LiteLLM" } });
  resetDefaultGatewayCache();
  useGatewayStore.getState().reset();
});

afterEach(() => {
  cleanup();
  features = featuresFromEnv({});
});

function renderChoice(extra: Record<string, unknown> = {}) {
  return render(
    <AgentChoice
      aria-label="Default agent"
      runtime="claude-code"
      agentOptions={{}}
      onRuntimeChange={vi.fn()}
      onOptionsChange={vi.fn()}
      {...extra}
    />,
  );
}

describe("AgentChoice under the default deployment", () => {
  it("offers every runtime and fetches no gateway", () => {
    renderChoice();
    expect(buttons("Default agent")).toEqual([
      "Claude Code",
      "OpenAI Codex",
      "GitHub Copilot",
      "Google Gemini",
      "Cursor",
      "OpenCode",
      "OpenClaw",
    ]);
    expect(pickerProps).toHaveBeenLastCalledWith(expect.objectContaining({ gateway: undefined }));
    expect(listModelProviders).not.toHaveBeenCalled();
    expect(getMyGateway).not.toHaveBeenCalled();
  });
});

describe("AgentChoice under the restricted deployment", () => {
  it("offers Claude Code and OpenCode alone", () => {
    features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
    renderChoice();
    expect(buttons("Default agent")).toEqual(["Claude Code", "OpenCode"]);
  });

  it("narrows a caller's own list too", () => {
    features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
    renderChoice({
      runtimes: ["claude-code", "codex", "copilot", "gemini", "opencode"].map((value) => ({
        value,
      })),
    });
    expect(buttons("Default agent")).toEqual(["Claude Code", "OpenCode"]);
  });

  it("offers the default gateway's catalog when no gateway is given", async () => {
    features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
    renderChoice();
    await waitFor(() =>
      expect(pickerProps).toHaveBeenLastCalledWith(
        expect.objectContaining({
          gateway: { id: "gw1", name: "LiteLLM" },
          providerModels: [{ id: "corp-opus", label: "Corp Opus" }],
        }),
      ),
    );
  });

  it("leaves a caller's explicit `gateway={null}` alone", async () => {
    features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
    renderChoice({ gateway: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(listModelProviders).not.toHaveBeenCalled();
    expect(pickerProps).toHaveBeenLastCalledWith(expect.objectContaining({ gateway: undefined }));
  });

  it("gives the review agent the same runtimes", () => {
    features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
    render(<ReviewAgentChoice agentType={null} model="" onChange={vi.fn()} />);
    expect(buttons("Review agent")).toEqual(["Repo default", "Claude Code", "OpenCode"]);
  });
});
