/**
 * Settings → Notifications against real Postgres (routes/notify.ts): a
 * person's own choices (and that upstream's push PUT leaves them alone),
 * and the SMTP relay — deployment admins only, the password sealed and
 * never returned, "Send test email" through a memory transport.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  notificationPreferences,
  notifySmtpSettings,
  users,
  workspaceMembers,
} from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { createMemoryEmailTransport, setEmailTransportForTests } from "../services/notify/email.js";
import { notificationRoutes } from "./notifications.js";
import { notifyRoutes } from "./notify.js";

const uniq = () => randomBytes(4).toString("hex");
const mail = createMemoryEmailTransport();

async function person(name: string, deploymentAdmin = false) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: uniq(),
      email: `${name}-${uniq()}@example.test`,
      displayName: name,
      deploymentAdmin,
    })
    .returning();
  return row;
}

async function appFor(
  userId: string,
  workspaceId: string,
  workspaceRole: "admin" | "member" | "viewer",
) {
  return buildRouteTestApp(
    async (app: FastifyInstance) => {
      await app.register(notificationRoutes);
      await app.register(notifyRoutes);
    },
    { user: { id: userId, workspaceId, workspaceRole } },
  );
}

const SMTP = {
  host: "relay.example.test",
  port: 587,
  security: "starttls-required",
  username: "optio",
  password: "relay-s3cret",
  from: "Optio <optio@example.test>",
};

beforeAll(() => setEmailTransportForTests(mail));
afterAll(() => setEmailTransportForTests(null));
beforeEach(async () => {
  mail.sent.length = 0;
  vi.stubEnv("OPTIO_SMTP_URL", "");
  vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
  await db.delete(notifySmtpSettings);
});

describe("my notification choices", () => {
  it("starts from the defaults and keeps what I change", async () => {
    const ws = await insertWorkspace();
    const me = await person("bob");
    const app = await appFor(me.id, ws.id, "member");

    const first = (await app.inject({ method: "GET", url: "/api/notifications/channels" })).json();
    // The work events first; other parts' kinds (budgets, tokens) follow them.
    const kinds = first.kinds.map((k: { kind: string }) => k.kind);
    expect(kinds.slice(0, 4)).toEqual([
      "task.pr_opened",
      "task.needs_attention",
      "task.failed",
      "task.completed",
    ]);
    expect(kinds).toContain("budget.warning");
    expect(first.choices.email["task.pr_opened"]).toBe(true);
    expect(first.choices.teamWork).toBe(true);
    expect(first.email).toEqual({ available: false, address: me.email });
    expect(first.push).toEqual({ available: false });

    const put = await app.inject({
      method: "PUT",
      url: "/api/notifications/channels",
      payload: { email: { "task.failed": false, "task.completed": true }, teamWork: false },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().choices.email).toMatchObject({
      "task.pr_opened": true,
      "task.failed": false,
      "task.completed": true,
    });
    expect(put.json().choices.teamWork).toBe(false);
  });

  it("survives upstream's push PUT (the phone apps), and keeps upstream's other keys", async () => {
    const ws = await insertWorkspace();
    const me = await person("bob");
    const app = await appFor(me.id, ws.id, "member");
    await app.inject({
      method: "PUT",
      url: "/api/notifications/channels",
      payload: { email: { "task.failed": false }, push: { "task.failed": false } },
    });
    // The iOS / Android apps write push through upstream's route.
    const upstream = await app.inject({
      method: "PUT",
      url: "/api/notifications/preferences",
      payload: { "task.failed": { push: true }, "task.stalled": { push: true } },
    });
    expect(upstream.statusCode).toBe(200);

    const mine = (await app.inject({ method: "GET", url: "/api/notifications/channels" })).json();
    expect(mine.choices.email["task.failed"]).toBe(false);
    expect(mine.choices.push["task.failed"]).toBe(true);

    // And ours keeps upstream's keys it doesn't show.
    await app.inject({
      method: "PUT",
      url: "/api/notifications/channels",
      payload: { push: { "task.pr_opened": false } },
    });
    const [row] = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, me.id));
    expect(row.preferences["task.stalled"]).toEqual({ push: true });
    expect(row.preferences["task.pr_opened"]).toEqual({ push: false });
  });

  it("refuses push for an event that has none, and a malformed kind", async () => {
    const ws = await insertWorkspace();
    const me = await person("bob");
    const app = await appFor(me.id, ws.id, "member");
    for (const payload of [
      { push: { "budget.warning": true } },
      { email: { "Not A Kind!": true } },
    ]) {
      const res = await app.inject({ method: "PUT", url: "/api/notifications/channels", payload });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe("the SMTP relay", () => {
  it("is a deployment admin's: a workspace admin can't read or change it", async () => {
    const ws = await insertWorkspace();
    const wsAdmin = await person("ann");
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws.id, userId: wsAdmin.id, role: "admin" });
    const app = await appFor(wsAdmin.id, ws.id, "admin");
    for (const [method, url, payload] of [
      ["GET", "/api/notifications/smtp", undefined],
      ["PUT", "/api/notifications/smtp", SMTP],
      ["DELETE", "/api/notifications/smtp", undefined],
      ["POST", "/api/notifications/smtp/test", {}],
    ] as const) {
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error).toMatch(/deployment admin/);
    }
  });

  it("saves it sealed, never returns the password, and keeps it when left blank", async () => {
    const ws = await insertWorkspace();
    const root = await person("root", true);
    const app = await appFor(root.id, ws.id, "admin");

    const saved = await app.inject({
      method: "PUT",
      url: "/api/notifications/smtp",
      payload: SMTP,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings).toMatchObject({
      configured: true,
      source: "app",
      host: "relay.example.test",
      port: 587,
      security: "starttls-required",
      username: "optio",
      hasPassword: true,
      from: "Optio <optio@example.test>",
    });
    expect(saved.body).not.toContain("relay-s3cret");
    const [row] = await db.select().from(notifySmtpSettings);
    expect(row.encryptedPassword?.toString("utf8") ?? "").not.toContain("relay-s3cret");

    // A blank password keeps the saved one; null clears it.
    await app.inject({
      method: "PUT",
      url: "/api/notifications/smtp",
      payload: { ...SMTP, password: "" },
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/notifications/smtp" })).json().settings
        .hasPassword,
    ).toBe(true);
    await app.inject({
      method: "PUT",
      url: "/api/notifications/smtp",
      payload: { ...SMTP, password: null },
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/notifications/smtp" })).json().settings
        .hasPassword,
    ).toBe(false);
  });

  it("never sends the stored password to another host or account", async () => {
    const ws = await insertWorkspace();
    const root = await person("root", true);
    const app = await appFor(root.id, ws.id, "admin");
    await app.inject({ method: "PUT", url: "/api/notifications/smtp", payload: SMTP });
    for (const changed of [{ host: "evil.example" }, { username: "someone-else" }]) {
      const tried = await app.inject({
        method: "POST",
        url: "/api/notifications/smtp/test",
        payload: { settings: { ...SMTP, ...changed, password: "" } },
      });
      expect(tried.statusCode).toBe(400);
      expect(tried.json().error).toMatch(/Enter the password again/);
      const saved = await app.inject({
        method: "PUT",
        url: "/api/notifications/smtp",
        payload: { ...SMTP, ...changed, password: "" },
      });
      expect(saved.statusCode).toBe(400);
    }
    expect(mail.sent).toHaveLength(0);
    // The same host and account keep it (the host's case doesn't matter).
    const same = await app.inject({
      method: "POST",
      url: "/api/notifications/smtp/test",
      payload: { settings: { ...SMTP, host: "RELAY.example.test", password: "" } },
    });
    expect(same.json()).toMatchObject({ ok: true });
  });

  it("says what's wrong with a setting", async () => {
    const ws = await insertWorkspace();
    const root = await person("root", true);
    const app = await appFor(root.id, ws.id, "admin");
    const bad = await app.inject({
      method: "PUT",
      url: "/api/notifications/smtp",
      payload: { ...SMTP, from: "nobody" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/From address is an address/);
    const host = await app.inject({
      method: "PUT",
      url: "/api/notifications/smtp",
      payload: { ...SMTP, host: "smtp://relay" },
    });
    expect(host.json().error).toMatch(/without smtp:\/\//);
  });

  it("sends a test email to the admin, through the saved relay or unsaved settings", async () => {
    const ws = await insertWorkspace();
    const root = await person("root", true);
    const app = await appFor(root.id, ws.id, "admin");

    // Nothing set up yet.
    const none = (
      await app.inject({ method: "POST", url: "/api/notifications/smtp/test", payload: {} })
    ).json();
    expect(none).toEqual({ ok: false, to: root.email, error: "Email isn't set up on this Optio" });

    // Unsaved settings from the form.
    const tried = await app.inject({
      method: "POST",
      url: "/api/notifications/smtp/test",
      payload: { settings: SMTP },
    });
    expect(tried.json()).toMatchObject({ ok: true, to: root.email });
    expect(mail.sent[0]).toMatchObject({
      to: [root.email],
      from: "optio@example.test",
      subject: "[Optio] Test email",
    });

    await app.inject({ method: "PUT", url: "/api/notifications/smtp", payload: SMTP });
    const saved = await app.inject({
      method: "POST",
      url: "/api/notifications/smtp/test",
      payload: { to: "ops@example.test" },
    });
    expect(saved.json()).toMatchObject({ ok: true, to: "ops@example.test" });

    mail.failWith("The relay refused the user name or password (535 5.7.8)");
    const failed = (
      await app.inject({ method: "POST", url: "/api/notifications/smtp/test", payload: {} })
    ).json();
    expect(failed).toMatchObject({ ok: false, error: expect.stringMatching(/535/) });
    mail.failWith(null);

    const badTo = await app.inject({
      method: "POST",
      url: "/api/notifications/smtp/test",
      payload: { to: "x" },
    });
    expect(badTo.statusCode).toBe(400);
  });

  it("goes back to the deployment's OPTIO_SMTP_URL when the app's settings are removed", async () => {
    const ws = await insertWorkspace();
    const root = await person("root", true);
    const app = await appFor(root.id, ws.id, "admin");
    vi.stubEnv("OPTIO_SMTP_URL", "smtps://svc:pw@mail.example.test");
    vi.stubEnv("OPTIO_SMTP_FROM", "optio@example.test");
    await app.inject({ method: "PUT", url: "/api/notifications/smtp", payload: SMTP });
    const removed = (await app.inject({ method: "DELETE", url: "/api/notifications/smtp" })).json();
    expect(removed.settings).toMatchObject({
      configured: true,
      source: "env",
      host: "mail.example.test",
      port: 465,
      security: "tls",
      username: "svc",
      hasPassword: true,
      envConfigured: true,
    });
    expect(JSON.stringify(removed)).not.toContain('"pw"');
  });
});
