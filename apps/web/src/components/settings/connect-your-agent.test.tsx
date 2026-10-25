import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const createApiKey = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    createApiKey: (...a: unknown[]) => createApiKey(...a),
    controllerMcpDownloadUrl: () => "/api/downloads/controller-mcp.js",
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let currentUser: any = {
  user: { id: "u1", displayName: "Jon", workspaceId: "ws-1", workspaceRole: "member" },
  userId: "u1",
  isAdmin: false,
  loaded: true,
  authDisabled: false,
};
vi.mock("@/hooks/use-current-user", () => ({ useCurrentUser: () => currentUser }));

import {
  ConnectYourAgent,
  TOKEN_PLACEHOLDER,
  claudeAddCommand,
  claudeSettingsSnippet,
  opencodeSnippet,
  stdioSnippet,
} from "./connect-your-agent";

beforeEach(() => {
  createApiKey.mockReset();
  (window as any).__OPTIO_CONFIG = { publicApiUrl: "https://optio.example.com" };
});

afterEach(() => {
  cleanup();
  delete (window as any).__OPTIO_CONFIG;
});

describe("snippets", () => {
  const server = "https://optio.example.com";

  it("build the Claude Code command with the token and workspace headers", () => {
    expect(claudeAddCommand(server, "optio_pat_abc", "ws-1")).toBe(
      'claude mcp add --transport http optio https://optio.example.com/api/mcp --header "Authorization: Bearer optio_pat_abc" --header "X-Workspace-Id: ws-1"',
    );
    expect(claudeAddCommand(server, "optio_pat_abc", null)).not.toContain("X-Workspace-Id");
  });

  it("build the config files for Claude Code and OpenCode", () => {
    expect(JSON.parse(claudeSettingsSnippet(server, "t", "ws-1"))).toEqual({
      mcpServers: {
        optio: {
          type: "http",
          url: "https://optio.example.com/api/mcp",
          headers: { Authorization: "Bearer t", "X-Workspace-Id": "ws-1" },
        },
      },
    });
    expect(JSON.parse(opencodeSnippet(server, "t", "ws-1")).mcp.optio).toMatchObject({
      type: "remote",
      url: "https://optio.example.com/api/mcp",
      headers: { Authorization: "Bearer t" },
    });
  });

  it("give the stdio adapter exactly the variables it reads", () => {
    const entry = JSON.parse(stdioSnippet(server, "t", "ws-1")).mcpServers.optio;
    expect(entry.command).toBe("node");
    expect(Object.keys(entry.env)).toEqual([
      "OPTIO_MCP_URL",
      "OPTIO_MCP_TOKEN",
      "OPTIO_WORKSPACE_ID",
    ]);
    expect(entry.env.OPTIO_MCP_URL).toBe("https://optio.example.com/api/mcp");
  });
});

describe("ConnectYourAgent", () => {
  it("shows the placeholder, then the minted token in the command", async () => {
    createApiKey.mockResolvedValue({
      token: "optio_pat_fresh123",
      tokenId: "k1",
      name: "MCP: Claude Code",
      expiresAt: null,
    });

    render(<ConnectYourAgent />);

    const command = () => screen.getByTestId("snippet-command").textContent ?? "";
    expect(command()).toContain("https://optio.example.com/api/mcp");
    expect(command()).toContain(TOKEN_PLACEHOLDER);

    fireEvent.click(screen.getByTestId("mint-token"));

    await waitFor(() => expect(command()).toContain("Bearer optio_pat_fresh123"));
    expect(createApiKey).toHaveBeenCalledWith({ name: "MCP: Claude Code" });
    expect(command()).toContain("X-Workspace-Id: ws-1");
    expect(screen.getByTestId("snippet-config").textContent).toContain("optio_pat_fresh123");
    expect(screen.getByTestId("token-note")).toBeInTheDocument();
  });

  it("offers the stdio download and names the token after the client", async () => {
    createApiKey.mockResolvedValue({
      token: "optio_pat_x",
      tokenId: "k2",
      name: "MCP: stdio bridge",
      expiresAt: null,
    });
    render(<ConnectYourAgent />);

    fireEvent.click(screen.getByRole("button", { name: "Other (stdio)" }));
    expect(screen.getByTestId("download-bridge")).toHaveAttribute(
      "href",
      "/api/downloads/controller-mcp.js",
    );
    expect(screen.getByTestId("snippet-config").textContent).toContain("OPTIO_MCP_TOKEN");

    fireEvent.click(screen.getByTestId("mint-token"));
    await waitFor(() => expect(createApiKey).toHaveBeenCalledWith({ name: "MCP: stdio bridge" }));
  });

  it("warns when the API address is a loopback one", () => {
    (window as any).__OPTIO_CONFIG = { publicApiUrl: "http://localhost:30400" };
    render(<ConnectYourAgent />);
    expect(screen.getByText(/another computer cannot use/)).toBeInTheDocument();
  });

  it("uses a placeholder bearer and no mint button when auth is off", () => {
    currentUser = { ...currentUser, authDisabled: true };
    render(<ConnectYourAgent />);
    expect(screen.queryByTestId("mint-token")).toBeNull();
    expect(screen.getByTestId("snippet-command").textContent).toContain("Bearer dev");
    currentUser = { ...currentUser, authDisabled: false };
  });
});
