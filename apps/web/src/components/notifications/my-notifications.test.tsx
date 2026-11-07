import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MyChannels } from "@/lib/notify-api";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let currentUser: any = { user: { id: "u1", adminTeamIds: [] }, loaded: true };
vi.mock("@/hooks/use-current-user", () => ({ useCurrentUser: () => currentUser }));

const getMyChannels = vi.fn();
const updateMyChannels = vi.fn();
vi.mock("@/lib/notify-api", () => ({
  notifyApi: {
    getMyChannels: () => getMyChannels(),
    updateMyChannels: (p: unknown) => updateMyChannels(p),
  },
}));

import { toast } from "sonner";
import { MyNotifications } from "./my-notifications";

function channels(over: Partial<MyChannels> = {}): MyChannels {
  return {
    kinds: [
      {
        kind: "task.pr_opened",
        label: "Merge request waiting for you",
        description: "Your work opened a merge request.",
        about: "work",
        push: true,
      },
      {
        kind: "task.completed",
        label: "Merged",
        description: "Your work's merge request was merged.",
        about: "work",
        push: true,
      },
    ],
    choices: {
      email: { "task.pr_opened": true, "task.completed": false },
      push: { "task.pr_opened": true, "task.completed": true },
      teamWork: true,
    },
    email: { available: true, address: "bob@example.test" },
    push: { available: false },
    ...over,
  };
}

beforeEach(() => {
  getMyChannels.mockReset();
  updateMyChannels.mockReset();
  currentUser = { user: { id: "u1", adminTeamIds: [] }, loaded: true };
});
afterEach(() => cleanup());

describe("Settings → Notifications → What reaches you", () => {
  it("says where email goes and shows a switch per event", async () => {
    getMyChannels.mockResolvedValue(channels());
    render(<MyNotifications />);
    expect(await screen.findByText("bob@example.test")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Email: Merge request waiting for you" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Email: Merged" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.queryByRole("switch", { name: /^Push:/ })).toBeNull();
    // The team switch only for a team admin.
    expect(screen.queryByRole("switch", { name: "Your teams' work too" })).toBeNull();
  });

  it("saves one switch at a time", async () => {
    getMyChannels.mockResolvedValue(channels());
    updateMyChannels.mockResolvedValue(
      channels({
        choices: {
          ...channels().choices,
          email: { "task.pr_opened": true, "task.completed": true },
        },
      }),
    );
    render(<MyNotifications />);
    fireEvent.click(await screen.findByRole("switch", { name: "Email: Merged" }));
    expect(updateMyChannels).toHaveBeenCalledWith({ email: { "task.completed": true } });
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Email: Merged" })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
  });

  it("puts a switch back when saving fails", async () => {
    getMyChannels.mockResolvedValue(channels());
    updateMyChannels.mockRejectedValue(new Error("nope"));
    render(<MyNotifications />);
    fireEvent.click(
      await screen.findByRole("switch", { name: "Email: Merge request waiting for you" }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("nope"));
    expect(
      screen.getByRole("switch", { name: "Email: Merge request waiting for you" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("says when email isn't set up yet", async () => {
    getMyChannels.mockResolvedValue(
      channels({ email: { available: false, address: "bob@example.test" } }),
    );
    render(<MyNotifications />);
    expect(await screen.findByTestId("email-status")).toHaveTextContent(
      "Email isn't set up on this Optio yet",
    );
  });
});
