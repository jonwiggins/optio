import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

const getAuthProviders = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { getAuthProviders: () => getAuthProviders() },
}));

import { PairMachineGuide, cliServerUrl, isLoopbackUrl, pairingCommands } from "./pair-machine";

const host = (id: string, state: "online" | "offline", extra: Record<string, unknown> = {}) => ({
  id,
  name: `Machine ${id}`,
  state,
  dirs: [],
  ...extra,
});

beforeEach(() => {
  getAuthProviders.mockReset();
  delete (window as any).__OPTIO_CONFIG;
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("pairingCommands", () => {
  it("signs in first when the server has auth", () => {
    const cmds = pairingCommands("https://optio.example.com", false);
    expect(cmds.login).toEqual(["optio login --server https://optio.example.com"]);
    expect(cmds.up).toEqual(["optio local up"]);
  });

  it("names the server on the daemon itself when auth is off", () => {
    const cmds = pairingCommands("http://localhost:30400", true);
    expect(cmds.login).toBeNull();
    expect(cmds.up).toEqual(["optio --server http://localhost:30400 local up"]);
  });
});

describe("cliServerUrl", () => {
  it("is the API as the browser reaches it", () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "");
    (window as any).__OPTIO_CONFIG = { publicApiUrl: "https://api.optio.test" };
    expect(cliServerUrl()).toBe("https://api.optio.test");
    delete (window as any).__OPTIO_CONFIG;
    expect(cliServerUrl()).toBe(window.location.origin);
  });
});

describe("isLoopbackUrl", () => {
  it("flags addresses only this computer can use", () => {
    expect(isLoopbackUrl("http://localhost:30400")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:4000")).toBe(true);
    expect(isLoopbackUrl("https://optio.example.com")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});

describe("PairMachineGuide", () => {
  it("shows this server's commands and waits for a machine", async () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "");
    (window as any).__OPTIO_CONFIG = { publicApiUrl: "http://localhost:30400" };
    getAuthProviders.mockResolvedValue({ providers: [], authDisabled: true });
    render(<PairMachineGuide hosts={[]} loading={false} />);

    expect(
      await screen.findByText("optio --server http://localhost:30400 local up"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/optio login/)).not.toBeInTheDocument();
    expect(screen.getByText(/only reaches Optio from the computer it runs on/)).toBeInTheDocument();
    expect(screen.getByText("Waiting for a machine to connect…")).toBeInTheDocument();
  });

  it("asks to sign in when the server has auth", async () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "");
    (window as any).__OPTIO_CONFIG = { publicApiUrl: "https://optio.example.com" };
    getAuthProviders.mockResolvedValue({ providers: [{ name: "github" }], authDisabled: false });
    render(<PairMachineGuide hosts={[]} loading={false} />);
    expect(
      await screen.findByText("optio login --server https://optio.example.com"),
    ).toBeInTheDocument();
    expect(screen.getByText("optio local up")).toBeInTheDocument();
    expect(screen.queryByText(/only reaches Optio/)).not.toBeInTheDocument();
  });

  it("announces a machine that comes online after it opened — not one already there", async () => {
    getAuthProviders.mockResolvedValue({ providers: [], authDisabled: true });
    const { rerender } = render(
      <PairMachineGuide hosts={[host("old", "online")]} loading={false} />,
    );
    await waitFor(() => expect(getAuthProviders).toHaveBeenCalled());
    expect(screen.getByText("Waiting for a machine to connect…")).toBeInTheDocument();

    rerender(
      <PairMachineGuide hosts={[host("old", "online"), host("new", "online")]} loading={false} />,
    );
    expect(screen.getByText("Machine new")).toBeInTheDocument();
    expect(screen.getByText(/is connected — now add the directories/)).toBeInTheDocument();
  });

  it("doesn't mistake machines that were still loading for new ones", () => {
    getAuthProviders.mockResolvedValue({ providers: [], authDisabled: true });
    const { rerender } = render(<PairMachineGuide hosts={[]} loading />);
    rerender(<PairMachineGuide hosts={[host("old", "online")]} loading={false} />);
    expect(screen.getByText("Waiting for a machine to connect…")).toBeInTheDocument();
  });
});
