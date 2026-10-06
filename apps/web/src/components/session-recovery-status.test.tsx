import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SessionRecoveryStatus } from "./session-recovery-status";

const getSessionRecovery = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ api: { getSessionRecovery } }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("shows one server notice when both the host and browser stream are reconnecting", async () => {
  getSessionRecovery.mockResolvedValue({
    state: "reconnecting",
    message: "Waiting for your machine.",
  });
  render(<SessionRecoveryStatus kind="local" id="a" stream={{ state: "reconnecting" }} />);
  expect(await screen.findByText("Waiting for your machine.")).toBeVisible();
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.queryByText(/Waiting for the terminal connection/)).toBeNull();
});

it("reports a browser-only interruption and clears it when that connection recovers", async () => {
  getSessionRecovery.mockResolvedValue({ state: "live", message: "Connected." });
  const { rerender } = render(
    <SessionRecoveryStatus
      kind="local"
      id="a"
      stream={{ state: "disconnected", message: "Sign in again." }}
    />,
  );
  expect(await screen.findByText("Sign in again.")).toBeVisible();
  rerender(<SessionRecoveryStatus kind="local" id="a" stream={{ state: "connected" }} />);
  expect(screen.queryByRole("status")).toBeNull();
});

it("preserves the server's recovery instructions when the stream is reconnecting", async () => {
  getSessionRecovery.mockResolvedValue({
    state: "resumable",
    message: "Review the saved result before resuming.",
  });
  render(<SessionRecoveryStatus kind="local" id="a" stream={{ state: "reconnecting" }} />);
  expect(await screen.findByText("Review the saved result before resuming.")).toBeVisible();
  expect(screen.getAllByRole("status")).toHaveLength(1);
});
