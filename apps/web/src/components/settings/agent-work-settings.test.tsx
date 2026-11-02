import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  getAgentWorkPause: vi.fn(),
  setAgentWorkPause: vi.fn(),
  stopAllAgentWork: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { AgentWorkSettings } from "./agent-work-settings";

const state = (over: Record<string, unknown> = {}) => ({
  paused: false,
  reason: null,
  pausedAt: null,
  pausedBy: null,
  stopped: false,
  canEdit: true,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentWorkSettings", () => {
  it("is not shown to someone who isn't a deployment admin", async () => {
    api.getAgentWorkPause.mockResolvedValue(state({ canEdit: false }));
    const { container } = render(<AgentWorkSettings />);
    await waitFor(() => expect(api.getAgentWorkPause).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("pauses only with a reason, tells the banner, and resumes", async () => {
    api.getAgentWorkPause.mockResolvedValue(state());
    const changed = vi.fn();
    window.addEventListener("optio:agent-work-changed", changed);
    render(<AgentWorkSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Pause agent work…" }));
    const confirm = screen.getByRole("button", { name: "Pause agent work" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Why pause? Everyone sees this."), {
      target: { value: "  Upgrading the cluster " },
    });
    api.setAgentWorkPause.mockResolvedValue(
      state({
        paused: true,
        reason: "Upgrading the cluster",
        pausedAt: "2026-11-02T10:00:00.000Z",
        pausedBy: { id: "u1", name: "Dana" },
      }),
    );
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.setAgentWorkPause).toHaveBeenCalledWith({
        paused: true,
        reason: "Upgrading the cluster",
      }),
    );
    expect(await screen.findByTestId("agent-work-paused")).toBeTruthy();
    expect(screen.getByText(/Paused by Dana since .*: Upgrading the cluster/)).toBeTruthy();
    expect(changed).toHaveBeenCalledTimes(1);

    api.setAgentWorkPause.mockResolvedValue(state());
    fireEvent.click(screen.getByRole("button", { name: "Resume agent work" }));
    await waitFor(() => expect(api.setAgentWorkPause).toHaveBeenLastCalledWith({ paused: false }));
    expect(await screen.findByRole("button", { name: "Pause agent work…" })).toBeTruthy();
    expect(changed).toHaveBeenCalledTimes(2);
    window.removeEventListener("optio:agent-work-changed", changed);
  });

  it("stops everything after a confirmation with a reason, and reports what it cancelled", async () => {
    api.getAgentWorkPause.mockResolvedValue(state());
    render(<AgentWorkSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop everything…" }));
    expect(
      screen.getByText(/cancels all queued and running agent work in every workspace/),
    ).toBeTruthy();

    // Cancel backs out without calling anything.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.stopAllAgentWork).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Stop everything…" }));
    fireEvent.change(screen.getByLabelText("Why stop everything? Everyone sees this."), {
      target: { value: "A leaked credential" },
    });
    api.stopAllAgentWork.mockResolvedValue({
      ...state({ paused: true, stopped: true, reason: "A leaked credential" }),
      cancelled: {
        tasks: 3,
        jobRuns: 1,
        reviews: 0,
        agents: 0,
        sessions: 2,
        terminals: 0,
        skipped: 0,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop everything" }));
    await waitFor(() => expect(api.stopAllAgentWork).toHaveBeenCalledWith("A leaked credential"));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("All agent work stopped", {
        description: "Cancelled 3 tasks, 1 job run, 2 sessions",
      }),
    );
    expect(await screen.findByTestId("agent-work-paused")).toBeTruthy();
  });

  it("keeps the form and says so when the API refuses", async () => {
    api.getAgentWorkPause.mockResolvedValue(state());
    api.setAgentWorkPause.mockRejectedValue(new Error("Only a deployment admin pauses"));
    render(<AgentWorkSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause agent work…" }));
    fireEvent.change(screen.getByLabelText("Why pause? Everyone sees this."), {
      target: { value: "Incident" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pause agent work" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't save", {
        description: "Only a deployment admin pauses",
      }),
    );
    expect(screen.getByRole("button", { name: "Pause agent work" })).toBeTruthy();
  });
});
