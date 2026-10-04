import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

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

import { ConnectionEditor, changedConfig } from "./connection-editor";

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
afterEach(() => cleanup());

describe("changedConfig", () => {
  it("keeps only touched fields; a blank secret is omitted, a cleared text field is null", () => {
    const schema = CONN.provider.configSchema;
    expect(changedConfig({ region: "us" }, { region: "us", apiToken: "" }, schema)).toEqual({});
    expect(changedConfig({ region: "us" }, { region: "eu", apiToken: "new" }, schema)).toEqual({
      region: "eu",
      apiToken: "new",
    });
    expect(changedConfig({ region: "us" }, { region: "" }, schema)).toEqual({ region: null });
  });
});

describe("ConnectionEditor", () => {
  it("loads the connection, locks the owner, and PATCHes only what changed", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    updateConnection.mockResolvedValue({ connection: { ...CONN, name: "Pylon prod" } });
    render(<ConnectionEditor connectionId="c1" open onClose={onClose} onSaved={onSaved} />);
    expect(screen.getByTestId("connection-editor")).toBeInTheDocument();
    const name = (await screen.findByLabelText("Connection name")) as HTMLInputElement;
    expect(name.value).toBe("Jon's Pylon");
    expect(screen.getByText("Private")).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Also export to the agent's shell" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "OpenAI Codex" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.change(name, { target: { value: "Pylon prod" } });
    fireEvent.click(screen.getByRole("switch", { name: "Also export to the agent's shell" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateConnection).toHaveBeenCalledWith("c1", {
      name: "Pylon prod",
      config: {},
      exportShellEnv: false,
      assignments: [{ repoId: null, agentTypes: ["codex"] }],
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("Test posts the health check and reports the outcome", async () => {
    testConnection.mockResolvedValue({
      connection: { ...CONN, status: "error", statusMessage: "401 from Pylon" },
    });
    render(<ConnectionEditor connectionId="c1" open onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText("Connection name");
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(testConnection).toHaveBeenCalledWith("c1"));
    expect(await screen.findByText(/401 from Pylon/)).toBeInTheDocument();
  });
});
