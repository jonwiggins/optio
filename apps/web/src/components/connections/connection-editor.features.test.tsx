import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const getConnection = vi.fn();
const updateConnection = vi.fn();
const testConnection = vi.fn();

vi.mock("@/lib/api-client", () => ({
  api: {
    getConnection: (...a: unknown[]) => getConnection(...a),
    updateConnection: (...a: unknown[]) => updateConnection(...a),
    testConnection: (...a: unknown[]) => testConnection(...a),
    listRepos: () => Promise.resolve({ repos: [] }),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The deployment's feature lists (default: everything); tests pick the restricted deployment's.
let features = featuresFromEnv({});
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ features, gatewayOnly: features.modelAccess === "gateway", loaded: true }),
}));

import { ConnectionEditor } from "./connection-editor";

const CONN = {
  id: "c1",
  name: "Jon's Pylon",
  providerId: "p1",
  config: { region: "us" },
  secretFields: ["apiToken"],
  exportShellEnv: true,
  parts: ["credentials", "env"],
  scope: "global",
  ownerUserId: "u1",
  enabled: true,
  status: "unknown",
  createdAt: new Date(),
  updatedAt: new Date(),
  assignments: [{ id: "a1", connectionId: "c1", repoId: null, agentTypes: ["codex"] }],
  provider: {
    id: "p1",
    slug: "pylon",
    name: "Pylon",
    icon: "pylon",
    builtIn: true,
    parts: ["credentials", "env"],
    shellEnv: { PYLON_API_TOKEN: "{{apiToken}}" },
    healthCheck: { kind: "http", url: "https://api.usepylon.com/me" },
    configSchema: {
      properties: {
        apiToken: { type: "string", title: "API token", format: "secret" },
        region: { type: "string", title: "Region", enum: ["us", "eu"] },
      },
      required: ["apiToken", "region"],
    },
  },
};

beforeEach(() => {
  getConnection.mockReset().mockResolvedValue({ connection: CONN });
  updateConnection.mockReset();
  testConnection.mockReset();
});
afterEach(() => {
  cleanup();
  features = featuresFromEnv({});
});

describe("ConnectionEditor's agent chips by features", () => {
  it("offers every agent under the default deployment", async () => {
    render(<ConnectionEditor connectionId="c1" open onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText("Connection name");
    expect(screen.getByRole("button", { name: "OpenAI Codex" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "GitHub Copilot" })).toBeInTheDocument();
  });

  it("offers Claude Code and OpenCode alone under the restricted deployment", async () => {
    features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
    render(<ConnectionEditor connectionId="c1" open onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText("Connection name");
    expect(screen.getByRole("button", { name: "Claude Code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "OpenCode" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "OpenAI Codex" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "GitHub Copilot" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Google Gemini" })).not.toBeInTheDocument();
  });
});
