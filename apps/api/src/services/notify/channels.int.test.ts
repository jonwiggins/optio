/**
 * A person's own chat hook and a team's channel (services/notify/
 * chat-hooks.ts, fanout.ts) against real Postgres: work events and
 * `notify()` reach each person's hook as they chose, only for work they may
 * see; a team's channel gets its own team's work and nothing else; the
 * notices other parts send (tokens, budgets, someone who left) reach email
 * and chat. Deliveries are sent at once here (no worker in this process).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  notifyChatHooks,
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
import { notify } from "../notify.js";
import {
  createMemoryChatTransport,
  getPersonalHook,
  hookUrlOf,
  setChatTransportForTests,
  setPersonalHook,
  setTeamChannel,
} from "./chat-hooks.js";
import { notifyWorkEvent } from "./dispatch.js";
import { createMemoryEmailTransport, setEmailTransportForTests } from "./email.js";
import { outboxActive } from "./outbox.js";
import { updateChannelChoices } from "./preferences.js";

const uniq = () => randomBytes(4).toString("hex");
const mail = createMemoryEmailTransport();
const chat = createMemoryChatTransport();

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

const hookOf = (name: string) => `https://chat.example.test/hooks/${name}-${uniq()}`;

async function setup() {
  const ws = await insertWorkspace({ workVisibility: "teams" });
  const [owner, lead, member, outsider, other] = await Promise.all(
    ["owner", "lead", "member", "outsider", "other"].map(person),
  );
  await db.insert(workspaceMembers).values([
    { workspaceId: ws.id, userId: owner.id, role: "member" },
    { workspaceId: ws.id, userId: lead.id, role: "member" },
    { workspaceId: ws.id, userId: member.id, role: "member" },
    { workspaceId: ws.id, userId: outsider.id, role: "member" },
  ]);
  const [team, otherTeam] = await db
    .insert(teams)
    .values([
      { workspaceId: ws.id, name: "Platform", slug: `platform-${uniq()}` },
      { workspaceId: ws.id, name: "Data", slug: `data-${uniq()}` },
    ])
    .returning();
  await db.insert(teamMembers).values([
    { teamId: team.id, userId: lead.id, role: "admin" },
    { teamId: team.id, userId: owner.id, role: "member" },
    { teamId: team.id, userId: member.id, role: "member" },
    { teamId: otherTeam.id, userId: outsider.id, role: "admin" },
  ]);
  const hooks: Record<string, string> = {};
  for (const [name, p] of Object.entries({ owner, lead, member, outsider, other })) {
    hooks[name] = hookOf(name);
    await setPersonalHook(p.id, { url: hooks[name], format: "mattermost" });
  }
  hooks.team = hookOf("platform");
  await setTeamChannel(team, lead.id, { url: hooks.team, format: "msteams" });
  hooks.otherTeam = hookOf("data");
  await setTeamChannel(otherTeam, outsider.id, { url: hooks.otherTeam, format: "mattermost" });
  return { ws, team, otherTeam, owner, lead, member, outsider, other, hooks };
}

/** The hooks that got something, by the names setup gave them. */
function postedTo(hooks: Record<string, string>): string[] {
  const byUrl = new Map(Object.entries(hooks).map(([k, v]) => [v, k]));
  return chat.posts.map((p) => byUrl.get(p.url) ?? p.url).sort();
}

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
  chat.failWith(null);
  vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.test:25");
  vi.stubEnv("OPTIO_SMTP_FROM", "optio@example.test");
  vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
  await db.delete(notifySmtpSettings);
});

describe("chat hooks", () => {
  it("seals the URL and shows only a hint", async () => {
    const p = await person("sealed");
    await setPersonalHook(p.id, {
      url: "https://chat.example.test/hooks/abcdefgh1234",
      format: "mattermost",
    });
    const [row] = await db
      .select()
      .from(notifyChatHooks)
      .where(eq(notifyChatHooks.ownerUserId, p.id));
    expect(row.urlHint).toBe("https://chat.example.test/hooks/…1234");
    expect(row.encryptedUrl.toString("utf8")).not.toContain("abcdefgh1234");
    expect(hookUrlOf(row)).toBe("https://chat.example.test/hooks/abcdefgh1234");
    // A save without a URL keeps it.
    await setPersonalHook(p.id, { format: "msteams" });
    const kept = (await getPersonalHook(p.id))!;
    expect(kept.format).toBe("msteams");
    expect(hookUrlOf(kept)).toBe("https://chat.example.test/hooks/abcdefgh1234");
  });
});

describe("work events on chat", () => {
  it("runs inline here: no worker in this process", () => {
    expect(outboxActive()).toBe(false);
  });

  it("posts a team's failed Task to its owner's hook, its admin's, and the team's channel", async () => {
    const s = await setup();
    const task = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      ownerTeamId: s.team.id,
      createdBy: s.owner.id,
      title: "Fix the login page",
      state: "failed",
      errorMessage: "tests failed",
    });
    const out = await notifyWorkEvent(task.id, "failed");
    expect(out.sent.sort()).toEqual([s.owner.id, s.lead.id].sort());
    expect(out.chat?.sort()).toEqual([s.owner.id, s.lead.id].sort());
    expect(out.teamChannel).toBe(true);
    // Not the other members, not another team's channel or admin.
    expect(postedTo(s.hooks)).toEqual(["lead", "owner", "team"]);
    const mm = chat.posts.find((p) => p.url === s.hooks.owner)!.body;
    expect(String(mm.text)).toMatch(/Task failed/);
    expect(String(mm.text)).toContain(`https://optio.example.test/work/${task.id}`);
    // The team's channel is Teams: an Adaptive Card.
    const card = chat.posts.find((p) => p.url === s.hooks.team)!.body as {
      attachments: Array<{ contentType: string }>;
    };
    expect(card.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
    // Email went too.
    expect(mail.sent.map((m) => m.to[0]).sort()).toEqual([s.owner.email, s.lead.email].sort());
  });

  it("never posts a person's own work to their team's channel", async () => {
    const s = await setup();
    const task = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.member.id,
      createdBy: s.member.id,
      state: "failed",
    });
    const out = await notifyWorkEvent(task.id, "failed");
    expect(out.teamChannel).toBeUndefined();
    expect(postedTo(s.hooks)).toEqual(["member"]);
  });

  it("posts a team's Job run failure to the team's channel, not another team's", async () => {
    const s = await setup();
    const job = await insertWorkflow({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      ownerTeamId: s.team.id,
      maxRetries: 0,
    });
    const run = await insertWorkflowRun(job.id, {
      ownerTeamId: s.team.id,
      state: "failed",
      errorMessage: "exit 3",
    });
    const out = await notifyWorkEvent(run.id, "failed");
    expect(out.teamChannel).toBe(true);
    expect(postedTo(s.hooks)).toEqual(["lead", "owner", "team"]);
    const mm = chat.posts.find((p) => p.url === s.hooks.owner)!.body;
    expect(String(mm.text)).toMatch(/Job run failed/);
    expect(String(mm.text)).toContain(`/jobs/${job.id}/runs/${run.id}`);
  });

  it("follows each person's chat choice apart from email, and the team's event list", async () => {
    const s = await setup();
    await updateChannelChoices(s.owner.id, { chat: { "task.pr_opened": false } });
    await updateChannelChoices(s.lead.id, { teamWork: false });
    // The team's channel posts failures only.
    await setTeamChannel(s.team, s.lead.id, { format: "msteams", events: ["task.failed"] });
    const task = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      ownerTeamId: s.team.id,
      createdBy: s.owner.id,
      state: "pr_opened",
      prUrl: "https://gitlab.example.test/platform/app/-/merge_requests/7",
    });
    const out = await notifyWorkEvent(task.id, "pr_opened");
    // The owner still gets the email (email stays on); no chat; the lead nothing.
    expect(out.sent).toEqual([s.owner.id]);
    expect(out.chat).toBeUndefined();
    expect(out.teamChannel).toBeUndefined();
    expect(chat.posts).toHaveLength(0);
    expect(mail.sent.map((m) => m.to[0])).toEqual([s.owner.email]);
    expect(out.skipped).toEqual([{ userId: s.lead.id, why: "turned off" }]);
  });

  it("tells nobody who may not see the work, on any channel", async () => {
    const s = await setup();
    // The owner left the workspace; their hook stays, but the work isn't theirs to see now.
    await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, s.owner.id));
    const task = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      createdBy: s.owner.id,
      state: "failed",
    });
    const out = await notifyWorkEvent(task.id, "failed");
    expect(out.sent).toEqual([]);
    expect(chat.posts).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("posts with no relay at all, and stays quiet with neither relay nor hooks", async () => {
    const s = await setup();
    vi.stubEnv("OPTIO_SMTP_URL", "");
    const task = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      createdBy: s.owner.id,
      state: "needs_attention",
    });
    const out = await notifyWorkEvent(task.id, "needs_attention");
    expect(out.sent).toEqual([s.owner.id]);
    expect(postedTo(s.hooks)).toEqual(["owner"]);
    expect(mail.sent).toHaveLength(0);

    await db.update(notifyChatHooks).set({ enabled: false });
    chat.posts.length = 0;
    const quiet = await notifyWorkEvent(task.id, "needs_attention");
    expect(quiet).toEqual({ kind: "task.needs_attention", sent: [], skipped: [] });
    expect(chat.posts).toHaveLength(0);
    await db.update(notifyChatHooks).set({ enabled: true });
  });
});

describe("notify() on chat: the notices other parts send", () => {
  it("brings token, budget and offboarding notices to email and the person's hook", async () => {
    const s = await setup();
    for (const kind of ["token.expiring", "token.invalid", "budget.warning", "budget.exceeded"]) {
      chat.posts.length = 0;
      mail.sent.length = 0;
      const r = await notify({
        kind,
        toUserIds: [s.member.id],
        workspaceId: s.ws.id,
        subject: `About ${kind}`,
        body: "Line one.\nLine *two*.",
        link: "/settings#my-tokens",
      });
      expect(r, kind).toMatchObject({ sent: [s.member.id], chat: [s.member.id] });
      expect(postedTo(s.hooks), kind).toEqual(["member"]);
      expect(
        mail.sent.map((m) => m.to[0]),
        kind,
      ).toEqual([s.member.email]);
      const text = String(chat.posts[0].body.text);
      expect(text).toContain(`#### About ${kind.replace(/_/g, "\\_")}`);
      // The body's Markdown is shown as written; the link is Optio's.
      expect(text).toContain("Line \\*two\\*.");
      expect(text).toContain("[Open in Optio](https://optio.example.test/settings#my-tokens)");
    }
    chat.posts.length = 0;
    const left = await notify({
      kind: "user.offboarded",
      toUserIds: [s.lead.id],
      workspaceId: s.ws.id,
      subject: "Carol can no longer use Optio",
      body: "Their automations were paused.",
      force: true,
    });
    expect(left.chat).toEqual([s.lead.id]);
  });

  it("follows the person's chat choice for a notice, and `force` skips it", async () => {
    const s = await setup();
    await updateChannelChoices(s.member.id, {
      chat: { "token.expiring": false },
      email: { "token.expiring": false },
    });
    const input = {
      kind: "token.expiring",
      toUserIds: [s.member.id],
      workspaceId: s.ws.id,
      subject: "Your token expires soon",
      body: "In 7 days.",
    };
    expect(await notify(input)).toEqual({
      sent: [],
      skipped: [{ userId: s.member.id, why: "turned off" }],
    });
    expect(chat.posts).toHaveLength(0);
    const forced = await notify({ ...input, force: true });
    expect(forced).toMatchObject({ sent: [s.member.id], chat: [s.member.id] });
  });

  it("posts a team's budget notice to its channel only when the channel takes it", async () => {
    const s = await setup();
    const input = {
      kind: "budget.warning",
      toTeamAdminsOf: s.team.id,
      subject: "Platform used 80% of its gateway budget",
      body: "80 of 100 USD.",
      link: `/teams/${s.team.id}`,
    };
    // By default a team channel takes the team's work, not its budget.
    let r = await notify(input);
    expect(r.teamChannels).toBeUndefined();
    expect(postedTo(s.hooks)).toEqual(["lead"]);

    chat.posts.length = 0;
    await setTeamChannel(s.team, s.lead.id, {
      format: "msteams",
      events: ["task.failed", "budget.warning"],
    });
    r = await notify(input);
    expect(r.teamChannels).toEqual([s.team.id]);
    expect(postedTo(s.hooks)).toEqual(["lead", "team"]);
  });

  it("keeps a team's channel out of another workspace's notice and of others' work", async () => {
    const s = await setup();
    await setTeamChannel(s.team, s.lead.id, {
      format: "msteams",
      events: ["task.failed", "budget.warning"],
    });
    const elsewhere = await insertWorkspace();
    const r = await notify({
      kind: "budget.warning",
      toTeamAdminsOf: s.team.id,
      workspaceId: elsewhere.id,
      subject: "s",
      body: "b",
    });
    expect(r.teamChannels).toBeUndefined();
    // A notice about a person's work addressed to the team's admins: not the team's channel.
    const work = {
      workspaceId: s.ws.id,
      ownerUserId: s.member.id,
      ownerTeamId: null,
      createdBy: s.member.id,
    };
    const r2 = await notify({
      kind: "task.failed",
      toTeamAdminsOf: s.team.id,
      work,
      subject: "s",
      body: "b",
    });
    expect(r2.teamChannels).toBeUndefined();
    expect(postedTo(s.hooks)).not.toContain("team");
  });

  it("reaches someone without an email address on their hook", async () => {
    const s = await setup();
    await db.update(users).set({ email: "not-an-address" }).where(eq(users.id, s.member.id));
    const r = await notify({
      kind: "token.invalid",
      toUserIds: [s.member.id],
      workspaceId: s.ws.id,
      subject: "Your token was refused",
      body: "Replace it.",
    });
    expect(r).toMatchObject({ sent: [s.member.id], chat: [s.member.id] });
    expect(mail.sent).toHaveLength(0);
  });

  it("says why when a person has no way to be reached", async () => {
    const s = await setup();
    await db.delete(notifyChatHooks).where(eq(notifyChatHooks.ownerUserId, s.member.id));
    vi.stubEnv("OPTIO_SMTP_URL", "");
    const r = await notify({
      kind: "token.invalid",
      toUserIds: [s.member.id],
      workspaceId: s.ws.id,
      subject: "s",
      body: "b",
    });
    expect(r.sent).toEqual([]);
    expect(r.skipped[0].why).toMatch(/No way to reach them/);
  });
});
