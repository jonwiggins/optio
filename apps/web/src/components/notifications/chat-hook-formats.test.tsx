import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatHookView } from "@/lib/notify-api";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const api = vi.hoisted(() => ({
  saveMyChatHook: vi.fn(),
  deleteMyChatHook: vi.fn(),
  testMyChatHook: vi.fn(),
  getTeamChannel: vi.fn(),
  saveTeamChannel: vi.fn(),
  deleteTeamChannel: vi.fn(),
  testTeamChannel: vi.fn(),
}));
vi.mock("@/lib/notify-api", () => ({ notifyApi: api }));

import { CHAT_FORMATS, MyChatHook, formatForUrl } from "./my-chat-hook";
import { TeamChatChannel } from "../teams/team-chat-channel";

const saved = (format: ChatHookView["format"]): ChatHookView => ({
  id: "h1",
  format,
  urlHint: "https://chat.example.com/hooks/…9f3c",
  enabled: true,
  lastSentAt: null,
  lastError: null,
  lastErrorAt: null,
  updatedAt: "2026-10-24T10:00:00Z",
});

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
});
afterEach(() => cleanup());

describe("the chat a hook posts to", () => {
  it("lists every chat service alphabetically, with where to make its hook", () => {
    render(<MyChatHook hook={null} onChanged={vi.fn()} />);
    const select = screen.getByLabelText("Chat") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Choose the chat…",
      "Discord",
      "Google Chat",
      "Mattermost",
      "Microsoft Teams",
      "Rocket.Chat",
      "Slack",
      "Webex",
      "Zulip",
    ]);
    for (const f of CHAT_FORMATS) expect(f.where).toBeTruthy();
  });

  it("picks the chat a pasted URL can only be, and saves it", async () => {
    api.saveMyChatHook.mockResolvedValue({ hook: saved("googlechat") });
    const onChanged = vi.fn();
    render(<MyChatHook hook={null} onChanged={onChanged} />);
    const url = "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token=t";
    fireEvent.change(screen.getByLabelText("Webhook URL"), { target: { value: url } });
    expect((screen.getByLabelText("Chat") as HTMLSelectElement).value).toBe("googlechat");
    expect(screen.getByText(/Apps & integrations/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.saveMyChatHook).toHaveBeenCalledWith({ url, format: "googlechat" }),
    );
    expect(onChanged).toHaveBeenCalledWith(saved("googlechat"));
  });

  it("keeps the chat chosen for a URL any server could have", async () => {
    api.saveMyChatHook.mockResolvedValue({ hook: saved("rocketchat") });
    render(<MyChatHook hook={null} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Chat"), { target: { value: "rocketchat" } });
    const url = "https://chat.example.com/hooks/abc/def";
    fireEvent.change(screen.getByLabelText("Webhook URL"), { target: { value: url } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.saveMyChatHook).toHaveBeenCalledWith({ url, format: "rocketchat" }),
    );
    expect(formatForUrl("https://chat.example.com/hooks/x", "zulip")).toBe("zulip");
    expect(formatForUrl("https://webexapis.com/v1/webhooks/incoming/x", "zulip")).toBe("webex");
  });

  it("starts with no chat chosen, and leaves the format to the API until one is", async () => {
    const refusal = "Choose the chat: Optio can't tell it from this URL";
    api.testMyChatHook.mockRejectedValue(new Error(refusal));
    api.saveMyChatHook.mockRejectedValue(new Error(refusal));
    render(<MyChatHook hook={null} onChanged={vi.fn()} />);
    const select = screen.getByLabelText("Chat") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.getByText(/Choose the chat to see where/)).toBeInTheDocument();
    expect(screen.getByLabelText("Webhook URL")).toHaveAttribute(
      "placeholder",
      "The incoming webhook's URL",
    );

    const url = "https://chat.example.com/hooks/abc";
    fireEvent.change(screen.getByLabelText("Webhook URL"), { target: { value: url } });
    expect(select.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(api.testMyChatHook).toHaveBeenCalledWith({ url });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveMyChatHook).toHaveBeenCalledWith({ url }));

    fireEvent.change(select, { target: { value: "zulip" } });
    expect(select.value).toBe("zulip");
    expect([...select.options].map((o) => o.value)).not.toContain("");
  });

  it("starts a team channel with no chat chosen, and shows a saved one's", async () => {
    const kinds = [{ kind: "task.failed", label: "Failed", description: "x", byDefault: true }];
    api.getTeamChannel.mockResolvedValue({ channel: null, kinds });
    const { unmount } = render(<TeamChatChannel teamId="t1" />);
    const empty = (await screen.findByLabelText("Team chat")) as HTMLSelectElement;
    expect(empty.value).toBe("");
    unmount();

    api.getTeamChannel.mockResolvedValue({
      channel: { ...saved("msteams"), events: ["task.failed"] },
      kinds,
    });
    render(<TeamChatChannel teamId="t1" />);
    const set = (await screen.findByLabelText("Team chat")) as HTMLSelectElement;
    expect(set.value).toBe("msteams");
    expect([...set.options].map((o) => o.value)).not.toContain("");
  });

  it("shows a saved hook's chat by name", () => {
    render(<MyChatHook hook={saved("rocketchat")} onChanged={vi.fn()} />);
    expect((screen.getByLabelText("Chat") as HTMLSelectElement).value).toBe("rocketchat");
    expect(screen.getAllByText("Rocket.Chat").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Webhook URL")).toHaveAttribute(
      "placeholder",
      "https://chat.example.com/hooks/…9f3c",
    );
  });

  it("picks a team channel's chat from its URL too", async () => {
    api.getTeamChannel.mockResolvedValue({
      channel: null,
      kinds: [{ kind: "task.failed", label: "Failed", description: "x", byDefault: true }],
    });
    api.saveTeamChannel.mockResolvedValue({
      channel: { ...saved("webex"), events: ["task.failed"] },
      kinds: [{ kind: "task.failed", label: "Failed", description: "x", byDefault: true }],
    });
    render(<TeamChatChannel teamId="t1" />);
    const url = "https://webexapis.com/v1/webhooks/incoming/abc";
    fireEvent.change(await screen.findByLabelText("Team webhook URL"), {
      target: { value: url },
    });
    expect((screen.getByLabelText("Team chat") as HTMLSelectElement).value).toBe("webex");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.saveTeamChannel).toHaveBeenCalledWith("t1", {
        url,
        format: "webex",
        events: ["task.failed"],
        enabled: true,
      }),
    );
  });
});
