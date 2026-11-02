import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({ getAgentWorkPause: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ api }));

import { AGENT_WORK_CHANGED_EVENT, AgentWorkPausedBanner } from "./agent-work-paused-banner";

const state = (over: Record<string, unknown> = {}) => ({
  paused: false,
  reason: null,
  pausedAt: null,
  pausedBy: null,
  stopped: false,
  canEdit: false,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentWorkPausedBanner", () => {
  it("shows nothing while agent work runs", async () => {
    api.getAgentWorkPause.mockResolvedValue(state());
    const { container } = render(<AgentWorkPausedBanner />);
    await waitFor(() => expect(api.getAgentWorkPause).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("shows everyone the reason while paused, without the settings link for non-admins", async () => {
    api.getAgentWorkPause.mockResolvedValue(state({ paused: true, reason: "Upgrading" }));
    render(<AgentWorkPausedBanner />);
    expect(
      await screen.findByText("Agent work is paused by an administrator: Upgrading"),
    ).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("links a deployment admin to the switch, and follows a change at once", async () => {
    api.getAgentWorkPause.mockResolvedValue(
      state({ paused: true, reason: "Incident", canEdit: true }),
    );
    render(<AgentWorkPausedBanner />);
    const link = await screen.findByRole("link", { name: "Resume in Settings → Access" });
    expect(link.getAttribute("href")).toBe("/settings#access");

    api.getAgentWorkPause.mockResolvedValue(state({ canEdit: true }));
    act(() => {
      window.dispatchEvent(new Event(AGENT_WORK_CHANGED_EVENT));
    });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("shows nothing when the state can't be read", async () => {
    api.getAgentWorkPause.mockRejectedValue(new Error("offline"));
    const { container } = render(<AgentWorkPausedBanner />);
    await waitFor(() => expect(api.getAgentWorkPause).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
