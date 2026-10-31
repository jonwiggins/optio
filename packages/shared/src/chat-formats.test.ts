import { describe, expect, it } from "vitest";
import {
  CHAT_SERVICES,
  chatFormatLabel,
  detectChatFormat,
  isChatFormat,
  isWebhookFormat,
  WEBHOOK_FORMAT_IDS,
} from "./chat-formats.js";

describe("chat formats", () => {
  it("lists the chat services alphabetically by name", () => {
    const labels = CHAT_SERVICES.map((s) => s.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    expect(WEBHOOK_FORMAT_IDS[0]).toBe("generic");
  });

  it("tells a format from anything else", () => {
    for (const f of [
      "discord",
      "googlechat",
      "mattermost",
      "msteams",
      "rocketchat",
      "slack",
      "webex",
      "zulip",
    ]) {
      expect(isChatFormat(f)).toBe(true);
      expect(isWebhookFormat(f)).toBe(true);
    }
    expect(isChatFormat("generic")).toBe(false);
    expect(isWebhookFormat("generic")).toBe(true);
    expect(isWebhookFormat("teams")).toBe(false);
    expect(isChatFormat(null)).toBe(false);
  });

  it("names a format", () => {
    expect(chatFormatLabel("rocketchat")).toBe("Rocket.Chat");
    expect(chatFormatLabel("googlechat")).toBe("Google Chat");
    expect(chatFormatLabel("irc")).toBe("irc");
  });
});

describe("detectChatFormat", () => {
  it.each([
    ["https://hooks.slack.com/services/T000/B000/XXXX", "slack"],
    ["https://discord.com/api/webhooks/123456789012345678/abc-DEF_123", "discord"],
    ["https://discord.com/api/v10/webhooks/1234/abc?wait=true", "discord"],
    ["https://ptb.discordapp.com/api/webhooks/1234/abc", "discord"],
    ["https://chat.googleapis.com/v1/spaces/AAAA1234/messages?key=k&token=t", "googlechat"],
    ["https://webexapis.com/v1/webhooks/incoming/Y2lzY29zcGFyazovL3Vz", "webex"],
    ["https://example.webhook.office.com/webhookb2/a@b/IncomingWebhook/c/d", "msteams"],
    ["https://team.cloud.mattermost.com/hooks/xyz123", "mattermost"],
    ["https://open.rocket.chat/hooks/abc/def", "rocketchat"],
    ["https://org.zulipchat.com/api/v1/external/slack_incoming?api_key=k&stream=s", "zulip"],
    ["https://zulip.example.com/api/v1/external/slack_incoming?api_key=k", "zulip"],
  ])("recognises %s as %s", (url, format) => {
    expect(detectChatFormat(url)).toBe(format);
  });

  it.each([
    // Self-hosted servers and receivers of any JSON could be anything.
    "https://chat.example.com/hooks/abc",
    "https://chat.example.com/hooks/abc/def",
    "https://receiver.example.com/optio",
    // Discord's Slack- and GitHub-compatible routes take other bodies.
    "https://discord.com/api/webhooks/1234/abc/slack",
    "https://discord.com/api/webhooks/1234/abc/github",
    // A Workflows flow takes whatever JSON it was built for.
    "https://prod-01.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke",
    // Another Zulip integration, or a look-alike host.
    "https://org.zulipchat.com/api/v1/external/json?api_key=k",
    "https://discord.com.example.com/api/webhooks/1234/abc",
    "https://evilrocket.chat/hooks/a/b",
    "ftp://hooks.slack.com/services/x",
    "not a url",
    "",
  ])("leaves %s to the explicit choice", (url) => {
    expect(detectChatFormat(url)).toBeNull();
  });
});
