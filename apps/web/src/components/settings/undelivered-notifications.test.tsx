import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OutboxView } from "@/lib/notify-api";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let current = { isDeploymentAdmin: true, loaded: true };
vi.mock("@/hooks/use-current-user", () => ({ useCurrentUser: () => current }));

const api = vi.hoisted(() => ({
  getOutbox: vi.fn(),
  retryOutbox: vi.fn(),
  discardOutbox: vi.fn(),
}));
vi.mock("@/lib/notify-api", () => ({ notifyApi: api }));

import { UndeliveredNotifications } from "./undelivered-notifications";

const VIEW: OutboxView = {
  pending: 2,
  dead: 2,
  oldestPendingAt: "2026-10-24T09:00:00Z",
  retry: { attempts: 10, baseSeconds: 30, deadLetterDays: 30 },
  items: [
    {
      id: "d1",
      channel: "email",
      kind: "task.failed",
      summary: "[Optio] Failed: Fix the login",
      to: "bob@example.test",
      attempts: 10,
      lastError: "Could not reach the relay (ETIMEDOUT)",
      createdAt: "2026-10-24T05:00:00Z",
      deadAt: "2026-10-24T09:15:00Z",
    },
    {
      id: "d2",
      channel: "chat",
      kind: "budget.warning",
      summary: "Platform used 80%",
      to: "Platform's channel",
      attempts: 1,
      lastError: "The chat answered HTTP 404",
      createdAt: "2026-10-24T05:00:00Z",
      deadAt: "2026-10-24T05:00:01Z",
    },
  ],
};

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  current = { isDeploymentAdmin: true, loaded: true };
});
afterEach(() => cleanup());

describe("Settings → Notifications → Undelivered", () => {
  it("is a deployment admin's only: nothing shows, nothing is asked, for anyone else", () => {
    current = { isDeploymentAdmin: false, loaded: true };
    const { container } = render(<UndeliveredNotifications />);
    expect(container).toBeEmptyDOMElement();
    expect(api.getOutbox).not.toHaveBeenCalled();
  });

  it("lists what Optio gave up on, with why, and retries one or all", async () => {
    api.getOutbox.mockResolvedValue(VIEW);
    api.retryOutbox.mockResolvedValue({ retried: 1 });
    render(<UndeliveredNotifications />);
    expect(await screen.findByText("[Optio] Failed: Fix the login")).toBeInTheDocument();
    expect(screen.getByText(/ETIMEDOUT/)).toBeInTheDocument();
    expect(screen.getByText(/To Platform's channel · 1 try/)).toBeInTheDocument();
    expect(screen.getByTestId("outbox-pending")).toHaveTextContent("2 waiting to be delivered");
    expect(screen.getByText(/tried 10 times, waiting 30 s/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry: [Optio] Failed: Fix the login" }));
    await waitFor(() => expect(api.retryOutbox).toHaveBeenCalledWith(["d1"]));
    fireEvent.click(screen.getByRole("button", { name: "Retry all" }));
    await waitFor(() => expect(api.retryOutbox).toHaveBeenLastCalledWith(undefined));
  });

  it("discards one", async () => {
    api.getOutbox.mockResolvedValue(VIEW);
    api.discardOutbox.mockResolvedValue({ discarded: 1 });
    render(<UndeliveredNotifications />);
    fireEvent.click(await screen.findByRole("button", { name: "Discard: Platform used 80%" }));
    await waitFor(() => expect(api.discardOutbox).toHaveBeenCalledWith(["d2"]));
  });
});
