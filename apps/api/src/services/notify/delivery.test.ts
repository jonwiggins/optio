import { afterEach, describe, expect, it, vi } from "vitest";
import { SsrfError } from "../../utils/outbound-url.js";
import {
  chatErrorIsPermanent,
  chatStatusIsPermanent,
  chatStatusMeaning,
  isTeamChannelKind,
  postChat,
  setChatTransportForTests,
  teamChannelKinds,
  urlHint,
  validateHookUrl,
} from "./chat-hooks.js";
import { digestDueDay, localParts, renderDigestEmail, type Digest } from "./digest.js";
import { emailFailureIsPermanent, retryPolicy } from "./outbox.js";
import { digestOf, mergeChoices, wantsChat } from "./preferences.js";

afterEach(() => {
  vi.unstubAllEnvs();
  setChatTransportForTests(null);
});

describe("retries", () => {
  it("tries ten times from 30 seconds by default, as the deployment says otherwise", () => {
    expect(retryPolicy()).toEqual({ attempts: 10, baseMs: 30_000, deadLetterDays: 30 });
    vi.stubEnv("OPTIO_NOTIFY_RETRY_ATTEMPTS", "4");
    vi.stubEnv("OPTIO_NOTIFY_RETRY_BASE_SECONDS", "5");
    vi.stubEnv("OPTIO_NOTIFY_DEAD_LETTER_DAYS", "7");
    expect(retryPolicy()).toEqual({ attempts: 4, baseMs: 5000, deadLetterDays: 7 });
    vi.stubEnv("OPTIO_NOTIFY_RETRY_ATTEMPTS", "nonsense");
    vi.stubEnv("OPTIO_NOTIFY_RETRY_BASE_SECONDS", "0");
    expect(retryPolicy().attempts).toBe(10);
    expect(retryPolicy().baseMs).toBe(10);
  });

  it("gives up on an email at once only when the relay refused it for good", () => {
    expect(emailFailureIsPermanent("No valid recipient address")).toBe(true);
    expect(
      emailFailureIsPermanent(
        "The relay refused every recipient: a@example.test (550 5.1.1 no such user)",
      ),
    ).toBe(true);
    // A 4xx (greylisting, a full mailbox for now) may pass.
    expect(
      emailFailureIsPermanent(
        "The relay refused every recipient: a@example.test (450 4.2.1 try later); b@example.test (550 no)",
      ),
    ).toBe(false);
    expect(emailFailureIsPermanent("The relay refused the message: 554 5.7.1 spam")).toBe(true);
    expect(emailFailureIsPermanent("The relay refused the message: 451 try later")).toBe(false);
    expect(emailFailureIsPermanent("Could not reach the relay relay:25 (ECONNREFUSED)")).toBe(
      false,
    );
    // A wrong password is an admin's to fix; the retries wait for it.
    expect(emailFailureIsPermanent("The relay refused the user name or password (535 …)")).toBe(
      false,
    );
  });

  it("gives up on a chat post the hook won't take, not one it may take later", () => {
    expect(chatStatusIsPermanent(404)).toBe(true);
    expect(chatStatusIsPermanent(400)).toBe(true);
    expect(chatStatusIsPermanent(429)).toBe(false);
    expect(chatStatusIsPermanent(408)).toBe(false);
    expect(chatStatusIsPermanent(503)).toBe(false);
    // The outbound policy's refusal stands; a name that didn't resolve may resolve later.
    expect(chatErrorIsPermanent(new SsrfError("blocked: host resolves to a private address"))).toBe(
      true,
    );
    expect(
      chatErrorIsPermanent(new SsrfError("chat.example.test could not be resolved (ENOTFOUND)")),
    ).toBe(false);
    expect(chatErrorIsPermanent(new Error("fetch failed"))).toBe(false);
  });
});

describe("chat hooks", () => {
  it("tells a refusal by its status and what it means, never by the text answered", async () => {
    const answers: Array<{ status: number; text: string }> = [];
    setChatTransportForTests({ post: async () => answers.shift()! });
    const msg = { type: "test" as const, sentBy: null, where: "a test" };
    const target = { url: "https://chat.example.test/hooks/abc", format: "mattermost" as const };
    answers.push({ status: 404, text: "<html>secret internal page</html>" });
    const gone = await postChat(target, msg);
    expect(gone).toEqual({
      ok: false,
      status: 404,
      error: "The chat answered HTTP 404: it has no such hook; it was deleted, or the URL is wrong",
      permanent: true,
    });
    answers.push({ status: 418, text: "secret" });
    expect(await postChat(target, msg)).toMatchObject({ error: "The chat answered HTTP 418" });
    answers.push({ status: 503, text: "secret" });
    const down = await postChat(target, msg);
    expect(down).toMatchObject({ status: 503, permanent: false });
    expect(JSON.stringify(down)).not.toContain("secret");
    answers.push({ status: 200, text: "ok" });
    expect(await postChat(target, msg)).toEqual({ ok: true, status: 200 });
    expect(chatStatusMeaning(400)).toMatch(/format/);
    expect(chatStatusMeaning(302)).toBe("");
  });

  it("takes an http(s) URL with a host and no credentials", () => {
    expect(validateHookUrl(" https://chat.example.test/hooks/abc ")).toBe(
      "https://chat.example.test/hooks/abc",
    );
    expect(validateHookUrl("http://mattermost.corp:8065/hooks/x")).toBe(
      "http://mattermost.corp:8065/hooks/x",
    );
    for (const bad of ["chat.example.test/hooks/x", "ftp://chat/x", "https://u:p@chat/x", ""]) {
      expect(() => validateHookUrl(bad), bad).toThrow();
    }
  });

  it("shows a hint of the URL, never enough to use it", () => {
    expect(urlHint("https://chat.example.test/hooks/k9x2abcd")).toBe(
      "https://chat.example.test/hooks/…abcd",
    );
    expect(
      urlHint("https://corp.webhook.office.com/webhookb2/aaa@bbb/IncomingWebhook/ccc/ddd-9f1e"),
    ).toBe("https://corp.webhook.office.com/webhookb2/…9f1e");
  });

  it("posts a team's work by default; its budget and tokens when its admins choose", () => {
    expect(teamChannelKinds({ events: null })).toEqual([
      "task.pr_opened",
      "task.needs_attention",
      "task.failed",
      "task.completed",
    ]);
    expect(teamChannelKinds({ events: ["budget.warning", "user.offboarded"] })).toEqual([
      "budget.warning",
    ]);
    expect(isTeamChannelKind("user.offboarded")).toBe(false);
  });

  it("follows the person's chat choice, with email's defaults", () => {
    const c = mergeChoices({ preferences: {}, channels: { chat: { "task.failed": false } } });
    expect(wantsChat(c, "task.failed", { why: "owner" })).toBe(false);
    expect(wantsChat(c, "task.pr_opened", { why: "owner" })).toBe(true);
    expect(wantsChat(c, "task.completed", { why: "owner" })).toBe(false);
    expect(wantsChat(c, "budget.warning", { why: "addressed" })).toBe(true);
    const off = mergeChoices({ preferences: {}, channels: { teamWork: false } });
    expect(wantsChat(off, "task.failed", { why: "team-admin", teamName: "P" })).toBe(false);
  });
});

describe("the digest", () => {
  it("keeps a sound choice and replaces a wrong one", () => {
    expect(digestOf(undefined)).toEqual({
      enabled: false,
      hour: 8,
      timeZone: "UTC",
      via: "email",
    });
    expect(digestOf({ enabled: true, hour: 17, timeZone: "Asia/Jerusalem", via: "both" })).toEqual({
      enabled: true,
      hour: 17,
      timeZone: "Asia/Jerusalem",
      via: "both",
    });
    expect(
      digestOf({ enabled: true, hour: 25, timeZone: "Mars/Base", via: "fax" as never }),
    ).toEqual({ enabled: true, hour: 8, timeZone: "UTC", via: "email" });
  });

  it("reads the local time in the person's zone", () => {
    expect(localParts(new Date("2026-10-20T22:30:00Z"), "Asia/Jerusalem")).toEqual({
      date: "2026-10-21",
      hour: 1,
      minute: 30,
    });
    expect(localParts(new Date("2026-10-20T00:05:00Z"), "UTC")).toEqual({
      date: "2026-10-20",
      hour: 0,
      minute: 5,
    });
  });

  it("is due from its hour for four hours, for the day that hour was on", () => {
    const at8 = { enabled: true, hour: 8, timeZone: "Europe/Berlin", via: "email" as const };
    // Berlin is UTC+2 on 20 October 2026.
    expect(digestDueDay(at8, new Date("2026-10-20T05:59:00Z"))).toBeNull();
    expect(digestDueDay(at8, new Date("2026-10-20T06:00:00Z"))).toBe("2026-10-20");
    expect(digestDueDay(at8, new Date("2026-10-20T09:59:00Z"))).toBe("2026-10-20");
    expect(digestDueDay(at8, new Date("2026-10-20T10:00:00Z"))).toBeNull();
    expect(digestDueDay({ ...at8, enabled: false }, new Date("2026-10-20T06:00:00Z"))).toBeNull();
    // A late hour whose window crosses midnight counts for the evening's day.
    const at23 = { ...at8, hour: 23, timeZone: "UTC" };
    expect(digestDueDay(at23, new Date("2026-10-20T23:30:00Z"))).toBe("2026-10-20");
    expect(digestDueDay(at23, new Date("2026-10-21T01:30:00Z"))).toBe("2026-10-20");
    expect(digestDueDay(at23, new Date("2026-10-21T03:00:00Z"))).toBeNull();
  });

  it("writes the email: counts in the subject, a line and a link per item", () => {
    const digest: Digest = {
      title: "Your Optio digest for Tuesday 20 October",
      sections: [
        {
          title: "Waiting for you",
          items: [{ name: "Add export", link: "/work/a", detail: "platform/app" }],
          more: 0,
        },
        {
          title: "Failed",
          items: [{ name: "Nightly", link: "/jobs/j/runs/r", detail: null }],
          more: 3,
        },
      ],
      empty: false,
      counts: { waiting: 1, failed: 4, merged: 0 },
    };
    const email = renderDigestEmail(
      digest,
      new Date("2026-10-19T06:00:00Z"),
      "UTC",
      "https://optio.example.test",
    );
    expect(email.subject).toBe(
      "[Optio] Your digest for Tuesday 20 October: 1 waiting for you, 4 failed",
    );
    expect(email.text).toContain(
      "Waiting for you (1)\n  - Add export — platform/app\n    https://optio.example.test/work/a",
    );
    expect(email.text).toContain("Failed (4)");
    expect(email.text).toContain("  - and 3 more");
    expect(email.text).toContain("https://optio.example.test/settings#notifications");
  });
});
