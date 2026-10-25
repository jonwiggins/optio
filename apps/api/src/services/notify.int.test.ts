/**
 * `notify()` (services/notify.ts), the call other parts of Optio use to
 * tell people something, against real Postgres: recipients by id and by
 * team admin, kept to the workspace and to who may see the work, each
 * person's choice for the kind, and `force`.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { teamMembers, teams, users, workspaceMembers } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { notify } from "./notify.js";
import { createMemoryEmailTransport, setEmailTransportForTests } from "./notify/email.js";
import { updateChannelChoices } from "./notify/preferences.js";

const uniq = () => randomBytes(4).toString("hex");
const mail = createMemoryEmailTransport();

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
  const ws = await insertWorkspace({ workVisibility: "teams" });
  const other = await insertWorkspace();
  const [admin, owner, lead, member, stranger] = await Promise.all(
    ["admin", "owner", "lead", "member", "stranger"].map(person),
  );
  await db.insert(workspaceMembers).values([
    { workspaceId: ws.id, userId: admin.id, role: "admin" },
    { workspaceId: ws.id, userId: owner.id, role: "member" },
    { workspaceId: ws.id, userId: lead.id, role: "member" },
    { workspaceId: ws.id, userId: member.id, role: "member" },
    // stranger is in another workspace only
    { workspaceId: other.id, userId: stranger.id, role: "member" },
  ]);
  const [team] = await db
    .insert(teams)
    .values({ workspaceId: ws.id, name: "Platform", slug: `platform-${uniq()}` })
    .returning();
  await db.insert(teamMembers).values([
    { teamId: team.id, userId: lead.id, role: "admin" },
    { teamId: team.id, userId: member.id, role: "member" },
    // A request that wasn't approved doesn't make an admin.
    { teamId: team.id, userId: owner.id, role: "admin", status: "requested" },
  ]);
  return { ws, other, team, admin, owner, lead, member, stranger };
}

const to = () => mail.sent.map((m) => m.to[0]).sort();

beforeAll(() => setEmailTransportForTests(mail));
afterAll(() => setEmailTransportForTests(null));
beforeEach(() => {
  mail.sent.length = 0;
  vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.test:25");
  vi.stubEnv("OPTIO_SMTP_FROM", "optio@example.test");
  vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
});

describe("notify()", () => {
  it("tells a team's active admins, with the link and why they get it", async () => {
    const s = await setup();
    const r = await notify({
      kind: "budget.warning",
      toTeamAdminsOf: s.team.id,
      subject: "Platform used 80% of this month's budget",
      body: "80 of 100 USD.",
      link: "/usage",
    });
    expect(r.sent).toEqual([s.lead.id]);
    expect(to()).toEqual([s.lead.email]);
    expect(mail.sent[0].subject).toBe("[Optio] Platform used 80% of this month's budget");
    expect(mail.sent[0].text).toContain("Open in Optio: https://optio.example.test/usage");
    expect(mail.sent[0].text).toContain("as an admin of the team Platform");
    expect(mail.sent[0].headers).toEqual({ "X-Optio-Event": "budget.warning" });
  });

  it("keeps to the workspace named", async () => {
    const s = await setup();
    const r = await notify({
      kind: "token.expiring",
      toUserIds: [s.owner.id, s.stranger.id],
      workspaceId: s.ws.id,
      subject: "Your token expires soon",
      body: "In 7 days.",
    });
    expect(r.sent).toEqual([s.owner.id]);
  });

  it("keeps a message about work to the people who may see that work", async () => {
    const s = await setup();
    const privateWork = { workspaceId: s.ws.id, ownerUserId: s.owner.id, createdBy: s.owner.id };
    const r = await notify({
      kind: "budget.warning",
      toUserIds: [s.owner.id, s.member.id, s.lead.id, s.admin.id, s.stranger.id],
      work: privateWork,
      subject: "This work's run cost more than expected",
      body: "…",
    });
    expect(r.sent.sort()).toEqual([s.owner.id, s.admin.id].sort());

    mail.sent.length = 0;
    const teamWork = { workspaceId: s.ws.id, ownerUserId: s.owner.id, ownerTeamId: s.team.id };
    await notify({
      kind: "budget.warning",
      toUserIds: [s.member.id, s.stranger.id],
      toTeamAdminsOf: s.team.id,
      work: teamWork,
      subject: "s",
      body: "b",
    });
    expect(to()).toEqual([s.lead.email, s.member.email].sort());
  });

  it("follows each person's choice for the kind, unless forced", async () => {
    const s = await setup();
    await updateChannelChoices(s.owner.id, { email: { "token.expiring": false } });
    const input = {
      kind: "token.expiring",
      toUserIds: [s.owner.id],
      workspaceId: s.ws.id,
      subject: "Your token expires soon",
      body: "In 7 days.",
    };
    const skipped = await notify(input);
    expect(skipped).toEqual({ sent: [], skipped: [{ userId: s.owner.id, why: "turned off" }] });
    const forced = await notify({ ...input, force: true });
    expect(forced.sent).toEqual([s.owner.id]);
  });

  it("sends nothing, and says why, with no relay or no one to tell", async () => {
    const s = await setup();
    expect(
      await notify({
        kind: "x",
        toUserIds: [s.stranger.id],
        workspaceId: s.ws.id,
        subject: "s",
        body: "b",
      }),
    ).toEqual({ sent: [], skipped: [], error: "No one to send it to" });
    vi.stubEnv("OPTIO_SMTP_URL", "");
    expect(await notify({ kind: "x", toUserIds: [s.owner.id], subject: "s", body: "b" })).toEqual({
      sent: [],
      skipped: [],
      error: "Email isn't set up on this Optio",
    });
    expect(mail.sent).toHaveLength(0);
  });
});
