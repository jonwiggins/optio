/**
 * Chat and email notifications (docs/notifications.md): a person's own
 * choices, their chat hook and digest, a team's channel, the SMTP relay and
 * what couldn't be delivered. The API is routes/notify.ts and
 * routes/notify-delivery.ts.
 */
import type { ChatFormat } from "@optio/shared";
import { request } from "@/lib/api-client";

export interface NotifyKindView {
  kind: string;
  label: string;
  description: string;
  about: "work" | "person";
  /** Has a push switch (browser / phone). */
  push: boolean;
}

export type DigestVia = "email" | "chat" | "both";

export interface DigestChoice {
  enabled: boolean;
  /** Local hour, 0 to 23. */
  hour: number;
  timeZone: string;
  via: DigestVia;
}

export interface ChannelChoices {
  email: Record<string, boolean>;
  /** Their own chat hook per event (absent from an older API). */
  chat?: Record<string, boolean>;
  push: Record<string, boolean>;
  teamWork: boolean;
  digest?: DigestChoice;
}

/** A chat service's format (@optio/shared `CHAT_SERVICES`, alphabetical by name). */
export type ChatHookFormat = ChatFormat;

export interface ChatHookView {
  id: string;
  format: ChatHookFormat;
  /** `https://chat.example.com/hooks/…a1b2`: never the whole URL. */
  urlHint: string;
  enabled: boolean;
  lastSentAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  updatedAt: string;
}

export interface MyChannels {
  kinds: NotifyKindView[];
  choices: ChannelChoices;
  email: { available: boolean; address: string | null };
  chat?: { hook: ChatHookView | null };
  push: { available: boolean };
}

export interface ChannelPatch {
  email?: Record<string, boolean>;
  chat?: Record<string, boolean>;
  push?: Record<string, boolean>;
  teamWork?: boolean;
  digest?: Partial<DigestChoice>;
}

export interface SaveChatHook {
  /** Empty keeps the saved URL. */
  url?: string;
  /** Left out: the one the URL can only be, else the saved one (else a 400). */
  format?: ChatHookFormat;
  enabled?: boolean;
}

export type ChatTestResult =
  { ok: true; status: number } | { ok: false; error: string; status?: number };

export interface DigestSendResult {
  ok: boolean;
  via: Array<"email" | "chat">;
  empty: boolean;
  counts: { waiting: number; failed: number; merged: number };
  error?: string;
}

export interface DeadLetter {
  id: string;
  channel: "email" | "chat";
  kind: string;
  summary: string;
  to: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  deadAt: string | null;
}

export interface OutboxView {
  pending: number;
  dead: number;
  oldestPendingAt: string | null;
  items: DeadLetter[];
  retry: { attempts: number; baseSeconds: number; deadLetterDays: number };
}

export type SmtpSecurity = "starttls" | "starttls-required" | "tls" | "none";

export interface SmtpSettingsView {
  configured: boolean;
  source: "app" | "env" | null;
  enabled: boolean;
  host: string;
  port: number | null;
  security: SmtpSecurity;
  username: string | null;
  hasPassword: boolean;
  from: string;
  caPem: string | null;
  insecureSkipVerify: boolean;
  envConfigured: boolean;
  envError: string | null;
}

export interface SaveSmtpSettings {
  host: string;
  port?: number | null;
  security: SmtpSecurity;
  username?: string | null;
  /** "" keeps the saved one, null clears it. */
  password?: string | null;
  from: string;
  caPem?: string | null;
  insecureSkipVerify?: boolean;
  enabled?: boolean;
}

export type TestEmailResult =
  { ok: true; to: string; response: string } | { ok: false; to: string; error: string };

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

export const notifyApi = {
  getMyChannels: () => request<MyChannels>("/api/notifications/channels"),
  updateMyChannels: (patch: ChannelPatch) =>
    request<MyChannels>("/api/notifications/channels", json("PUT", patch)),
  getSmtpSettings: () => request<{ settings: SmtpSettingsView }>("/api/notifications/smtp"),
  saveSmtpSettings: (settings: SaveSmtpSettings) =>
    request<{ settings: SmtpSettingsView }>("/api/notifications/smtp", json("PUT", settings)),
  deleteSmtpSettings: () =>
    request<{ settings: SmtpSettingsView }>("/api/notifications/smtp", json("DELETE")),
  sendTestEmail: (body: { to?: string; settings?: SaveSmtpSettings }) =>
    request<TestEmailResult>("/api/notifications/smtp/test", json("POST", body)),

  // The caller's own chat hook
  saveMyChatHook: (body: SaveChatHook) =>
    request<{ hook: ChatHookView }>("/api/notifications/chat-hook", json("PUT", body)),
  deleteMyChatHook: () =>
    request<{ hook: null; removed: boolean }>("/api/notifications/chat-hook", json("DELETE")),
  testMyChatHook: (body: { url?: string; format?: ChatHookFormat } = {}) =>
    request<ChatTestResult>("/api/notifications/chat-hook/test", json("POST", body)),
  sendMyDigestNow: () =>
    request<DigestSendResult>("/api/notifications/digest/test", json("POST", {})),

  getOutbox: () => request<OutboxView>("/api/notifications/outbox"),
  retryOutbox: (ids?: string[]) =>
    request<{ retried: number }>("/api/notifications/outbox/retry", json("POST", { ids })),
  discardOutbox: (ids?: string[]) =>
    request<{ discarded: number }>("/api/notifications/outbox/discard", json("POST", { ids })),
};
