import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TeamChannelView } from "@/lib/notify-api";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const api = vi.hoisted(() => ({
  getTeamChannel: vi.fn(),
  saveTeamChannel: vi.fn(),
  deleteTeamChannel: vi.fn(),
  testTeamChannel: vi.fn(),
}));
vi.mock("@/lib/notify-api", () => ({ notifyApi: api }));

import { TeamChatChannel } from "./team-chat-channel";

const KINDS: TeamChannelView["kinds"] = [
  { kind: "task.failed", label: "Failed", description: "Work failed.", byDefault: true },
  {
    kind: "budget.warning",
    label: "Gateway budget almost spent",
    description: "80% of the budget.",
    byDefault: false,
  },
];

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
});
afterEach(() => cleanup());

describe("Teams → a team → Team channel", () => {
  it("shows nothing to someone the API refuses", async () => {
    api.getTeamChannel.mockRejectedValue(new Error("Only the team's admins"));
    const { container } = render(<TeamChatChannel teamId="t1" />);
    await waitFor(() => expect(api.getTeamChannel).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("starts from the default events and saves the URL, format and events", async () => {
    api.getTeamChannel.mockResolvedValue({ channel: null, kinds: KINDS });
    api.saveTeamChannel.mockResolvedValue({
      channel: {
        id: "c1",
        format: "msteams",
        urlHint: "https://chat.example.test/hooks/…1111",
        enabled: true,
        events: ["task.failed", "budget.warning"],
        lastSentAt: null,
        lastError: null,
        lastErrorAt: null,
        updatedAt: "2026-10-24T10:00:00Z",
      },
      kinds: KINDS,
    });
    render(<TeamChatChannel teamId="t1" />);
    const failed = await screen.findByRole("checkbox", { name: /Failed/ });
    expect(failed).toBeChecked();
    const budget = screen.getByRole("checkbox", { name: /Gateway budget/ });
    expect(budget).not.toBeChecked();
    fireEvent.click(budget);
    fireEvent.change(screen.getByLabelText("Team chat"), { target: { value: "msteams" } });
    fireEvent.change(screen.getByLabelText("Team webhook URL"), {
      target: { value: "https://chat.example.test/hooks/platform-1111" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.saveTeamChannel).toHaveBeenCalledWith("t1", {
        url: "https://chat.example.test/hooks/platform-1111",
        format: "msteams",
        events: ["task.failed", "budget.warning"],
        enabled: true,
      }),
    );
    expect(await screen.findByLabelText("Team webhook URL")).toHaveAttribute(
      "placeholder",
      "https://chat.example.test/hooks/…1111",
    );
  });
});
