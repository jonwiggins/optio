/**
 * The daily digest (services/notify/digest.ts) against real Postgres: what
 * it lists is the person's own (and, for a team admin, their teams') work
 * that they may see, in the window since their last digest; the tick sends
 * it once per local day at their hour, by email or on their chat hook, and
 * nothing when there is nothing to say.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  notificationPreferences,
  notifySmtpSettings,
  teamMembers,
  teams,
  users,
  workspaceMembers,
} from "../../db/schema.js";
import {
  insertTask,
  insertWorkflow,
  insertWorkflowRun,
  insertWorkspace,
} from "../../test-utils/integration/fixtures.js";
import {
  createMemoryChatTransport,
  setChatTransportForTests,
  setPersonalHook,
} from "./chat-hooks.js";
import { buildDigest, runDigestTick } from "./digest.js";
import { createMemoryEmailTransport, setEmailTransportForTests } from "./email.js";
import { updateChannelChoices } from "./preferences.js";

const uniq = () => randomBytes(4).toString("hex");
const mail = createMemoryEmailTransport();
const chat = createMemoryChatTransport();
const HOUR = 3_600_000;

async function person(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: uniq(),
      email: `${name}-${uniq()}@example.test`,
      displayName: name,
    })
    .returning();
  return row;
}

async function setup() {
  const ws = await insertWorkspace({ name: "Acme", workVisibility: "teams" });
  const [me, mate, other] = await Promise.all(["me", "mate", "other"].map(person));
  await db.insert(workspaceMembers).values([
    { workspaceId: ws.id, userId: me.id, role: "member" },
    { workspaceId: ws.id, userId: mate.id, role: "member" },
    { workspaceId: ws.id, userId: other.id, role: "member" },
  ]);
  const [mine, notMine] = await db
    .insert(teams)
    .values([
      { workspaceId: ws.id, name: "Platform", slug: `platform-${uniq()}` },
      { workspaceId: ws.id, name: "Data", slug: `data-${uniq()}` },
    ])
    .returning();
  await db.insert(teamMembers).values([
    { teamId: mine.id, userId: me.id, role: "admin" },
    { teamId: mine.id, userId: mate.id, role: "member" },
    { teamId: notMine.id, userId: other.id, role: "admin" },
  ]);
  return { ws, me, mate, other, mine, notMine };
}

const titles = (d: Awaited<ReturnType<typeof buildDigest>>, section: string) =>
  (d.sections.find((s) => s.title === section)?.items ?? []).map((i) => i.name).sort();

beforeAll(() => {
  setEmailTransportForTests(mail);
  setChatTransportForTests(chat);
});
afterAll(() => {
  setEmailTransportForTests(null);
  setChatTransportForTests(null);
});
beforeEach(async () => {
  mail.sent.length = 0;
  chat.posts.length = 0;
  vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.test:25");
  vi.stubEnv("OPTIO_SMTP_FROM", "optio@example.test");
  vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
  await db.delete(notifySmtpSettings);
});

describe("what a digest lists", () => {
  it("my work and my teams' work that I may see: waiting, failed and merged in the window", async () => {
    const s = await setup();
    const now = new Date();
    const inWindow = new Date(now.getTime() - 2 * HOUR);
    const before = new Date(now.getTime() - 30 * HOUR);
    const base = { workspaceId: s.ws.id };
    await insertTask({
      ...base,
      ownerUserId: s.me.id,
      createdBy: s.me.id,
      title: "Mine waiting",
      state: "pr_opened",
    });
    await insertTask({
      ...base,
      ownerUserId: s.mate.id,
      ownerTeamId: s.mine.id,
      createdBy: s.mate.id,
      title: "Team needs me",
      state: "needs_attention",
    });
    await insertTask({
      ...base,
      ownerUserId: s.me.id,
      createdBy: s.me.id,
      title: "Mine failed",
      state: "failed",
      completedAt: inWindow,
      errorMessage: "tests failed",
    });
    await insertTask({
      ...base,
      ownerUserId: s.me.id,
      createdBy: s.me.id,
      title: "Old failure",
      state: "failed",
      completedAt: before,
    });
    await insertTask({
      ...base,
      ownerUserId: s.me.id,
      createdBy: s.me.id,
      title: "Mine merged",
      state: "completed",
      prState: "merged",
      completedAt: inWindow,
    });
    // Not mine: a mate's own work, another team's, the organization's I didn't start.
    await insertTask({
      ...base,
      ownerUserId: s.mate.id,
      createdBy: s.mate.id,
      title: "Mate's own",
      state: "pr_opened",
    });
    await insertTask({
      ...base,
      ownerUserId: s.other.id,
      ownerTeamId: s.notMine.id,
      createdBy: s.other.id,
      title: "Other team",
      state: "failed",
      completedAt: inWindow,
    });
    await insertTask({ ...base, createdBy: s.other.id, title: "Org work", state: "pr_opened" });
    // A review subtask's state is its parent's.
    await insertTask({
      ...base,
      ownerUserId: s.me.id,
      createdBy: s.me.id,
      title: "Review",
      taskType: "review",
      state: "failed",
      completedAt: inWindow,
    });
    // Another workspace's work, though mine, waits there: I'm not a member of it.
    const elsewhere = await insertWorkspace();
    await insertTask({
      workspaceId: elsewhere.id,
      ownerUserId: s.me.id,
      createdBy: s.me.id,
      title: "Elsewhere",
      state: "pr_opened",
    });

    const d = await buildDigest(s.me.id, {
      since: new Date(now.getTime() - 24 * HOUR),
      until: now,
      timeZone: "Europe/Berlin",
    });
    expect(titles(d, "Waiting for you")).toEqual(["Mine waiting", "Team needs me"]);
    expect(titles(d, "Failed")).toEqual(["Mine failed"]);
    expect(titles(d, "Merged")).toEqual(["Mine merged"]);
    expect(d.counts).toEqual({ waiting: 2, failed: 1, merged: 1 });
    const failed = d.sections.find((x) => x.title === "Failed")!.items[0];
    expect(failed.detail).toMatch(/tests failed/);
    expect(failed.link).toMatch(/^\/work\//);

    // "Your teams' work too" off: only my own.
    await updateChannelChoices(s.me.id, { teamWork: false });
    const own = await buildDigest(s.me.id, {
      since: new Date(now.getTime() - 24 * HOUR),
      until: now,
      timeZone: "UTC",
    });
    expect(titles(own, "Waiting for you")).toEqual(["Mine waiting"]);
  });

  it("counts a Job run's failure once, at its last try, and never a cancel", async () => {
    const s = await setup();
    const now = new Date();
    const at = new Date(now.getTime() - HOUR);
    const job = await insertWorkflow({
      workspaceId: s.ws.id,
      ownerUserId: s.me.id,
      name: "Nightly export",
      maxRetries: 2,
    });
    await insertWorkflowRun(job.id, {
      state: "failed",
      retryCount: 0,
      finishedAt: at,
      errorMessage: "boom",
    });
    await insertWorkflowRun(job.id, {
      state: "failed",
      retryCount: 2,
      finishedAt: at,
      errorMessage: "boom",
    });
    await insertWorkflowRun(job.id, {
      state: "failed",
      retryCount: 2,
      finishedAt: at,
      errorMessage: "Cancelled by user",
    });
    const d = await buildDigest(s.me.id, {
      since: new Date(now.getTime() - 24 * HOUR),
      until: now,
      timeZone: "UTC",
    });
    expect(d.counts.failed).toBe(1);
    const item = d.sections.find((x) => x.title === "Failed")!.items[0];
    expect(item.name).toBe("Nightly export");
    expect(item.link).toMatch(new RegExp(`^/jobs/${job.id}/runs/`));
  });

  it("hides work I can no longer see (I left the workspace)", async () => {
    const s = await setup();
    await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.me.id,
      createdBy: s.me.id,
      title: "Mine",
      state: "pr_opened",
    });
    await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, s.me.id));
    const now = new Date();
    const d = await buildDigest(s.me.id, {
      since: new Date(now.getTime() - HOUR),
      until: now,
      timeZone: "UTC",
    });
    expect(d.empty).toBe(true);
  });
});

describe("the digest tick", () => {
  it("sends at my hour, once per local day, by email and on my hook", async () => {
    const s = await setup();
    await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.me.id,
      createdBy: s.me.id,
      title: "Waiting one",
      state: "pr_opened",
    });
    await setPersonalHook(s.me.id, {
      url: "https://chat.example.test/hooks/me-digest",
      format: "mattermost",
    });
    await updateChannelChoices(s.me.id, {
      digest: { enabled: true, hour: 8, timeZone: "Asia/Jerusalem", via: "both" },
    });
    // 07:30 in Jerusalem (UTC+3 on this date): not yet.
    const early = new Date("2026-10-20T04:30:00Z");
    expect((await runDigestTick(early)).due).toBe(0);
    // 08:10: due — email and chat.
    const atEight = new Date("2026-10-20T05:10:00Z");
    expect(await runDigestTick(atEight)).toMatchObject({ due: 1, sent: 1 });
    expect(mail.sent.filter((m) => m.to[0] === s.me.email)).toHaveLength(1);
    expect(mail.sent[0].subject).toMatch(/Your digest for Tuesday 20 October: 1 waiting for you/);
    expect(mail.sent[0].text).toContain("Waiting one");
    expect(chat.posts).toHaveLength(1);
    expect(String(chat.posts[0].body.text)).toMatch(/Your Optio digest for Tuesday 20 October/);
    // Later the same morning: already sent.
    expect((await runDigestTick(new Date("2026-10-20T06:00:00Z"))).due).toBe(0);
    // Past the window (four hours) on a day it was missed: not sent late.
    await db
      .update(notificationPreferences)
      .set({ digestSentOn: null })
      .where(eq(notificationPreferences.userId, s.me.id));
    expect((await runDigestTick(new Date("2026-10-20T10:00:00Z"))).due).toBe(0);
    // The next morning: again.
    expect(await runDigestTick(new Date("2026-10-21T05:05:00Z"))).toMatchObject({
      due: 1,
      sent: 1,
    });
  });

  it("sends nothing when nothing happened, and nothing to a disabled account", async () => {
    const s = await setup();
    await updateChannelChoices(s.mate.id, {
      digest: { enabled: true, hour: 9, timeZone: "UTC", via: "email" },
    });
    const nine = new Date("2026-10-22T09:01:00Z");
    expect(await runDigestTick(nine)).toMatchObject({ sent: 0 });
    expect(mail.sent.filter((m) => m.to[0] === s.mate.email)).toHaveLength(0);

    await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.other.id,
      createdBy: s.other.id,
      title: "Other's",
      state: "pr_opened",
    });
    await updateChannelChoices(s.other.id, {
      digest: { enabled: true, hour: 9, timeZone: "UTC", via: "email" },
    });
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, s.other.id));
    await runDigestTick(new Date("2026-10-23T09:01:00Z"));
    expect(mail.sent.filter((m) => m.to[0] === s.other.email)).toHaveLength(0);
  });
});
