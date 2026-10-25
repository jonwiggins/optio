import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatHookView, MyChannels } from "@/lib/notify-api";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: () => ({ user: { id: "u1", adminTeamIds: [] }, loaded: true }),
}));

const api = vi.hoisted(() => ({
  getMyChannels: vi.fn(),
  updateMyChannels: vi.fn(),
  saveMyChatHook: vi.fn(),
  deleteMyChatHook: vi.fn(),
  testMyChatHook: vi.fn(),
  sendMyDigestNow: vi.fn(),
}));
vi.mock("@/lib/notify-api", () => ({ notifyApi: api }));

import { MyNotifications } from "./my-notifications";

const HOOK: ChatHookView = {
  id: "h1",
  format: "mattermost",
  urlHint: "https://chat.example.test/hooks/…9f3c",
  enabled: true,
  lastSentAt: null,
  lastError: null,
  lastErrorAt: null,
  updatedAt: "2026-10-24T10:00:00Z",
};

function channels(hook: ChatHookView | null): MyChannels {
  return {
    kinds: [
      {
        kind: "task.failed",
        label: "Failed",
        description: "Your work failed.",
        about: "work",
        push: true,
      },
    ],
    choices: {
      email: { "task.failed": true },
      chat: { "task.failed": true },
      push: { "task.failed": true },
      teamWork: true,
      digest: { enabled: false, hour: 8, timeZone: "UTC", via: "email" },
    },
    email: { available: true, address: "bob@example.test" },
    chat: { hook },
    push: { available: false },
  };
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
});
afterEach(() => cleanup());

describe("Settings → Notifications: your chat hook and digest", () => {
  it("adds a Chat column once a hook is set, and saves a chat choice on its own", async () => {
    api.getMyChannels.mockResolvedValue(channels(HOOK));
    api.updateMyChannels.mockImplementation(async () => channels(HOOK));
    render(<MyNotifications />);
    const chatSwitch = await screen.findByRole("switch", { name: "Chat: Failed" });
    expect(chatSwitch).toHaveAttribute("aria-checked", "true");
    fireEvent.click(chatSwitch);
    await waitFor(() =>
      expect(api.updateMyChannels).toHaveBeenCalledWith({ chat: { "task.failed": false } }),
    );
    // The saved hook shows as a hint, never the URL.
    expect(screen.getByLabelText("Webhook URL")).toHaveAttribute(
      "placeholder",
      "https://chat.example.test/hooks/…9f3c",
    );
  });

  it("has no Chat column without a hook; saving one brings it", async () => {
    api.getMyChannels.mockResolvedValue(channels(null));
    api.saveMyChatHook.mockResolvedValue({ hook: HOOK });
    render(<MyNotifications />);
    await screen.findByRole("switch", { name: "Email: Failed" });
    expect(screen.queryByRole("switch", { name: "Chat: Failed" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Chat"), { target: { value: "mattermost" } });
    fireEvent.change(screen.getByLabelText("Webhook URL"), {
      target: { value: "https://chat.example.test/hooks/abc9f3c" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.saveMyChatHook).toHaveBeenCalledWith({
        url: "https://chat.example.test/hooks/abc9f3c",
        format: "mattermost",
      }),
    );
    expect(await screen.findByRole("switch", { name: "Chat: Failed" })).toBeInTheDocument();
  });

  it("tests the hook and says what the chat answered", async () => {
    api.getMyChannels.mockResolvedValue(channels(HOOK));
    api.testMyChatHook.mockResolvedValue({ ok: false, error: "The chat answered HTTP 404" });
    render(<MyNotifications />);
    fireEvent.click(await screen.findByRole("button", { name: "Send test" }));
    expect(await screen.findByText(/Not sent: The chat answered HTTP 404/)).toBeInTheDocument();
  });

  it("turns the digest on in this browser's time zone, and sends one now", async () => {
    api.getMyChannels.mockResolvedValue(channels(HOOK));
    api.updateMyChannels.mockImplementation(async () => channels(HOOK));
    api.sendMyDigestNow.mockResolvedValue({
      ok: true,
      via: ["email"],
      empty: true,
      counts: { waiting: 0, failed: 0, merged: 0 },
    });
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    render(<MyNotifications />);
    fireEvent.click(await screen.findByRole("switch", { name: "Send me a daily digest" }));
    await waitFor(() =>
      expect(api.updateMyChannels).toHaveBeenCalledWith({
        digest: zone && zone !== "UTC" ? { enabled: true, timeZone: zone } : { enabled: true },
      }),
    );
    fireEvent.change(screen.getByLabelText("Digest hour"), { target: { value: "17" } });
    await waitFor(() =>
      expect(api.updateMyChannels).toHaveBeenCalledWith({ digest: { hour: 17 } }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send me one now" }));
    expect(
      await screen.findByText(/Sent by email \(nothing to report today\)/),
    ).toBeInTheDocument();
  });
});
