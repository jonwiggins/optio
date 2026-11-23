import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const getAuthProviders = vi.fn();
const getCliDownloads = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    getAuthProviders: () => getAuthProviders(),
    getCliDownloads: () => getCliDownloads(),
  },
}));

import { PairMachineGuide, detectClientOs, installCommands } from "./pair-machine";

const SERVER = "https://optio.example.com";
const ALL = { linux: true, darwin: true, win32: true };

beforeEach(() => {
  getAuthProviders.mockReset().mockResolvedValue({ providers: [], authDisabled: false });
  getCliDownloads.mockReset();
  vi.stubEnv("NEXT_PUBLIC_WS_URL", "");
  (window as any).__OPTIO_CONFIG = { publicApiUrl: SERVER };
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete (window as any).__OPTIO_CONFIG;
});

function stubOs(platform: string, userAgent = "Mozilla/5.0") {
  vi.stubGlobal("navigator", { ...window.navigator, platform, userAgent });
}

describe("detectClientOs", () => {
  it("reads the browser's OS", () => {
    expect(detectClientOs({ platform: "Win32" })).toBe("win32");
    expect(detectClientOs({ platform: "MacIntel" })).toBe("darwin");
    expect(detectClientOs({ platform: "Linux x86_64" })).toBe("linux");
    expect(detectClientOs({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS like Mac OS X)" })).toBe(
      "linux",
    );
    expect(detectClientOs(undefined)).toBe("linux");
  });
});

describe("installCommands", () => {
  it("download from this server, never a git host or registry", () => {
    expect(installCommands(SERVER, "posix")).toEqual([
      `curl -fsSL ${SERVER}/api/cli/install.sh | sh`,
      'export PATH="$HOME/.optio/bin:$PATH"',
    ]);
    expect(installCommands(SERVER, "powershell")).toEqual([
      `irm ${SERVER}/api/cli/install.ps1 | iex`,
      '$env:Path = "$HOME\\.optio\\bin;$env:Path"',
    ]);
  });
});

describe("PairMachineGuide with CLI bundles on the server", () => {
  it("installs from this server on the browser's OS, with no git clone", async () => {
    stubOs("MacIntel");
    getCliDownloads.mockResolvedValue({ bundles: ALL });
    const { container } = render(<PairMachineGuide hosts={[]} loading={false} />);
    expect(await screen.findByText("Install the CLI from this server")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "macOS" })).toHaveAttribute("aria-pressed", "true");
    expect(container.textContent).toContain(`curl -fsSL ${SERVER}/api/cli/install.sh | sh`);
    expect(container.textContent).not.toContain("git clone");
    expect(screen.getByText(`optio login --server ${SERVER}`)).toBeInTheDocument();
  });

  it("on Windows, pairs from WSL and offers the PowerShell CLI on the side", async () => {
    stubOs("Win32");
    getCliDownloads.mockResolvedValue({ bundles: ALL });
    const { container } = render(<PairMachineGuide hosts={[]} loading={false} />);
    expect(await screen.findByText("Install the CLI in WSL")).toBeInTheDocument();
    expect(screen.getByText(/the daemon runs in WSL/)).toBeInTheDocument();
    expect(container.textContent).toContain(`curl -fsSL ${SERVER}/api/cli/install.sh | sh`);
    expect(container.textContent).toContain(`irm ${SERVER}/api/cli/install.ps1 | iex`);
  });

  it("switches OS, and falls back to building when that OS has no bundle", async () => {
    stubOs("Linux x86_64");
    getCliDownloads.mockResolvedValue({ bundles: { linux: true, darwin: false, win32: false } });
    const { container } = render(<PairMachineGuide hosts={[]} loading={false} />);
    expect(await screen.findByText("Install the CLI from this server")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "macOS" }));
    expect(screen.getByText("Build the CLI")).toBeInTheDocument();
    expect(
      screen.getByText("This server has no macOS build of the CLI to download."),
    ).toBeInTheDocument();

    // Windows pairs through WSL, which takes the Linux bundle; no PowerShell one here.
    fireEvent.click(screen.getByRole("button", { name: "Windows" }));
    expect(screen.getByText("Install the CLI in WSL")).toBeInTheDocument();
    expect(container.textContent).not.toContain("install.ps1");
  });

  it("keeps the build steps, with no OS picker, when the server serves no bundles", async () => {
    getCliDownloads.mockResolvedValue({ bundles: { linux: false, darwin: false, win32: false } });
    render(<PairMachineGuide hosts={[]} loading={false} />);
    expect(await screen.findByText("Build the CLI")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "macOS" })).not.toBeInTheDocument();
    expect(screen.queryByText(/has no .* build/)).not.toBeInTheDocument();
  });
});
