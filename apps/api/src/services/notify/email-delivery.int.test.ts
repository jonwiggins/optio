import { Worker } from "bullmq";
import { once } from "node:events";
import { getBullMQOptions } from "../redis-config.js";
import { announceDisabled, disableUser } from "../offboarding.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { notifySmtpSettings, notifyOutbox, users, workspaceMembers } from "../../db/schema.js";
import { insertWorkspace } from "../../test-utils/integration/fixtures.js";
import { notify } from "../notify.js";
import { createMemoryEmailTransport, setEmailTransportForTests } from "./email.js";
import {
  closeOutboxQueue,
  NOTIFY_OUTBOX_QUEUE,
  outboxQueue,
  recoverOutbox,
  deliver,
  processOutboxRow,
  retryDeadLetters,
  setOutboxActive,
} from "./outbox.js";
import { configFromInput, saveSmtpSettings } from "./smtp-config.js";
import { filterVisible } from "./recipients.js";
import { getChannelChoices, updateChannelChoices } from "./preferences.js";
const mail = createMemoryEmailTransport();
async function fixture() {
  const ws = await insertWorkspace();
  const [person] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: randomUUID(),
      email: `${randomUUID()}@example.test`,
      displayName: "Recipient",
      emailVerified: true,
    })
    .returning();
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: ws.id, userId: person.id, role: "member" });
  return { ws, person };
}
beforeEach(() => {
  vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.test:25");
  vi.stubEnv("OPTIO_SMTP_FROM", "optio@example.test");
  setEmailTransportForTests(mail);
  mail.sent.length = 0;
  mail.failWith(null);
  setOutboxActive(false);
});
afterAll(async () => {
  setOutboxActive(false);
  await closeOutboxQueue();
  setEmailTransportForTests(null);
  vi.unstubAllEnvs();
});
describe("email notification boundaries and real delivery state", () => {
  it("delivers to the addressed workspace member and honors their email choice", async () => {
    const { ws, person } = await fixture();
    const input = {
      kind: "task.failed",
      toUserIds: [person.id],
      workspaceId: ws.id,
      subject: "Failed",
      body: "Needs attention",
    };
    expect((await notify(input)).sent).toEqual([person.id]);
    expect(mail.sent[0].to).toEqual([person.email]);
    await updateChannelChoices(person.id, { email: { "task.failed": false } });
    expect((await notify(input)).sent).toEqual([]);
    expect(mail.sent).toHaveLength(1);
  });
  it("never reuses a stored password for a transport downgrade or different port", async () => {
    const input = {
      host: "relay.example.test",
      port: 587,
      security: "starttls-required" as const,
      username: "optio",
      password: "DUMMY-PASSWORD",
      from: "optio@example.test",
    };
    await saveSmtpSettings(input, null);
    try {
      expect((await configFromInput({ ...input, password: "" })).password).toBe("DUMMY-PASSWORD");
      await expect(configFromInput({ ...input, password: "", security: "none" })).rejects.toThrow(
        /Enter the password again/,
      );
      await expect(configFromInput({ ...input, password: "", port: 25 })).rejects.toThrow(
        /Enter the password again/,
      );
      await expect(
        configFromInput({ ...input, password: "", insecureSkipVerify: true }),
      ).rejects.toThrow(/Enter the password again/);
    } finally {
      await db.delete(notifySmtpSettings);
    }
  });
  it("sends nothing on an unconfigured deployment", async () => {
    const { ws, person } = await fixture();
    vi.stubEnv("OPTIO_SMTP_URL", "");
    expect(
      (
        await notify({
          kind: "task.failed",
          toUserIds: [person.id],
          workspaceId: ws.id,
          subject: "Failed",
          body: "Private",
        })
      ).sent,
    ).toEqual([]);
    expect(mail.sent).toEqual([]);
  });
  it("never emails an address the provider did not verify", async () => {
    const { ws, person } = await fixture();
    await db.update(users).set({ emailVerified: false }).where(eq(users.id, person.id));
    expect(
      (
        await notify({
          kind: "task.failed",
          toUserIds: [person.id],
          workspaceId: ws.id,
          subject: "Failed",
          body: "Private",
        })
      ).sent,
    ).toEqual([]);
    expect(mail.sent).toEqual([]);
  });
  it("never selects a disabled person, even for a forced notice", async () => {
    const { ws, person } = await fixture();
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, person.id));
    expect(
      (
        await notify({
          kind: "user.offboarded",
          force: true,
          toUserIds: [person.id],
          workspaceId: ws.id,
          subject: "Private",
          body: "No delivery",
        })
      ).sent,
    ).toEqual([]);
    expect(mail.sent).toEqual([]);
  });
  it("drops queued mail when the recipient was disabled after selection", async () => {
    const { ws, person } = await fixture();
    setOutboxActive(true);
    expect(
      await deliver({
        channel: "email",
        kind: "task.failed",
        userId: person.id,
        workspaceId: ws.id,
        email: { to: [person.email], subject: "Queued", text: "Private" },
      }),
    ).toEqual({ ok: true, queued: true });
    const [row] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.userId, person.id));
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, person.id));
    expect(await processOutboxRow(row.id)).toEqual({
      outcome: "dropped",
      error: "the recipient's account is gone",
    });
    expect(mail.sent).toEqual([]);
    expect(await db.select().from(notifyOutbox).where(eq(notifyOutbox.id, row.id))).toEqual([]);
  });
  it("drops queued mail when its address loses verification", async () => {
    const { ws, person } = await fixture();
    setOutboxActive(true);
    await deliver({
      channel: "email",
      kind: "task.failed",
      userId: person.id,
      workspaceId: ws.id,
      email: { to: [person.email], subject: "Queued", text: "Private" },
    });
    const [row] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.userId, person.id));
    await db.update(users).set({ emailVerified: false }).where(eq(users.id, person.id));
    expect((await processOutboxRow(row.id)).outcome).toBe("dropped");
    expect(mail.sent).toEqual([]);
    expect(await db.select().from(notifyOutbox).where(eq(notifyOutbox.id, row.id))).toEqual([]);
  });
  it("delivers queued mail whose address differs from the account's only in case", async () => {
    const { ws, person } = await fixture();
    setOutboxActive(true);
    await deliver({
      channel: "email",
      kind: "task.failed",
      userId: person.id,
      workspaceId: ws.id,
      email: { to: [person.email.toUpperCase()], subject: "Queued", text: "Hello" },
    });
    const [row] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.userId, person.id));
    expect((await processOutboxRow(row.id)).outcome).toBe("delivered");
    expect(mail.sent).toHaveLength(1);
  });
  it("drops queued mail when the account's address changed meanwhile", async () => {
    const { ws, person } = await fixture();
    setOutboxActive(true);
    await deliver({
      channel: "email",
      kind: "task.failed",
      userId: person.id,
      workspaceId: ws.id,
      email: { to: [person.email], subject: "Queued", text: "Private" },
    });
    const [row] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.userId, person.id));
    await db
      .update(users)
      .set({ email: `moved-${person.email}` })
      .where(eq(users.id, person.id));
    expect((await processOutboxRow(row.id)).outcome).toBe("dropped");
    expect(mail.sent).toEqual([]);
  });
  it("keeps private work from another member and refuses a nonmember", async () => {
    const { ws, person } = await fixture();
    const other = await fixture();
    const candidates = [
      { userId: person.id, reason: { why: "addressed" as const } },
      { userId: other.person.id, reason: { why: "addressed" as const } },
    ];
    expect(
      await filterVisible(candidates, {
        workspaceId: ws.id,
        work: { workspaceId: ws.id, ownerUserId: other.person.id },
      }),
    ).toEqual([]);
  });
  it("keeps concurrent preference updates rather than losing one switch", async () => {
    const { person } = await fixture();
    await Promise.all([
      updateChannelChoices(person.id, { email: { "task.failed": false } }),
      updateChannelChoices(person.id, { email: { "task.pr_opened": false } }),
    ]);
    expect((await getChannelChoices(person.id)).email).toMatchObject({
      "task.failed": false,
      "task.pr_opened": false,
    });
  });
  it("tells only the enabled workspace admins about offboarding", async () => {
    const { ws, person } = await fixture();
    const [admin] = await db
      .insert(users)
      .values({
        provider: "oidc",
        externalId: randomUUID(),
        email: `${randomUUID()}@example.test`,
        displayName: "Workspace admin",
        emailVerified: true,
      })
      .returning();
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws.id, userId: admin.id, role: "admin" });
    const unrelated = await fixture();
    const disabled = await disableUser(person.id, { reason: "admin", byUserId: admin.id });
    expect(disabled).not.toBeNull();
    await announceDisabled(disabled!, { via: "admin", actorUserId: unrelated.person.id });
    expect(mail.sent.map((m) => m.to)).toEqual([[admin.email]]);
    expect(mail.sent[0].text).toContain(person.email);
    expect(mail.sent[0].to).not.toContain(unrelated.person.email);
  });
  it("does not email the administrator who disabled the account", async () => {
    const { ws, person } = await fixture();
    const operator = await fixture();
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws.id, userId: operator.person.id, role: "admin" });
    const disabled = await disableUser(person.id, {
      reason: "admin",
      byUserId: operator.person.id,
    });
    await announceDisabled(disabled!, { via: "admin", actorUserId: operator.person.id });
    expect(mail.sent).toEqual([]);
  });
  it("does not restart exhausted queue retries after exceptions before a row update", async () => {
    const { ws, person } = await fixture();
    vi.stubEnv("OPTIO_NOTIFY_RETRY_ATTEMPTS", "1");
    setOutboxActive(true);
    // Old jobs from preceding direct processOutboxRow tests are no longer useful.
    await outboxQueue().drain();
    const worker = new Worker(
      NOTIFY_OUTBOX_QUEUE,
      async () => {
        throw new Error("before database update");
      },
      getBullMQOptions(),
    );
    try {
      const failed = once(worker, "failed");
      await deliver({
        channel: "email",
        kind: "task.failed",
        userId: person.id,
        workspaceId: ws.id,
        email: { to: [person.email], subject: "Worker failure", text: "Private" },
      });
      await failed;
      const [row] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.userId, person.id));
      expect(row.attempts).toBe(0);
      const result = await recoverOutbox(new Date(Date.now() + 3 * 60_000));
      expect(result.requeued).toBe(0);
      const [dead] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.id, row.id));
      expect(dead.status).toBe("dead");
      expect(dead.attempts).toBe(1);
      expect(await outboxQueue().getJob(row.id)).toBeUndefined();
    } finally {
      await worker.close();
      vi.stubEnv("OPTIO_NOTIFY_RETRY_ATTEMPTS", "10");
    }
  });
  it("retains permanent failures for admin retry and then removes delivered rows", async () => {
    const { ws, person } = await fixture();
    setOutboxActive(true);
    mail.failWith("The relay refused the message: 554 no");
    await deliver({
      channel: "email",
      kind: "task.failed",
      userId: person.id,
      workspaceId: ws.id,
      email: { to: [person.email], subject: "Retry", text: "Text" },
    });
    const [row] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.userId, person.id));
    expect((await processOutboxRow(row.id)).outcome).toBe("dead");
    expect(
      (await db.select().from(notifyOutbox).where(eq(notifyOutbox.id, row.id)))[0].status,
    ).toBe("dead");
    mail.failWith(null);
    setOutboxActive(false);
    expect(await retryDeadLetters([row.id])).toBe(1);
    expect(mail.sent).toHaveLength(1);
    expect(await db.select().from(notifyOutbox).where(eq(notifyOutbox.id, row.id))).toEqual([]);
  });
});
