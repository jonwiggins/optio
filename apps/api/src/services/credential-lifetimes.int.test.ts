/**
 * Optional session and CLI key lifetimes (services/credential-lifetimes.ts)
 * against real Postgres: with nothing set nothing changes; a lower limit
 * applies to sessions that already exist; the app setting wins over the
 * environment, and 0 saved there means no limit.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { apiKeys, sessions } from "../db/schema.js";
import { createSession, validateSession } from "./session-service.js";
import { createApiKey, validateApiKey } from "./api-key-service.js";
import { forgetSwitches, setDeploymentSetting } from "./deployment-settings.js";
import { getRedisClient } from "./event-bus.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { authRoutes } from "../routes/auth.js";
import {
  CLI_KEY_MAX_DAYS,
  SESSION_IDLE_MINUTES,
  SESSION_MAX_HOURS,
  cliKeyExpiry,
} from "./credential-lifetimes.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function clearLimits() {
  for (const l of [SESSION_MAX_HOURS, SESSION_IDLE_MINUTES, CLI_KEY_MAX_DAYS])
    await setDeploymentSetting(l.key, null, null);
  forgetSwitches();
}

beforeEach(async () => {
  for (const l of [SESSION_MAX_HOURS, SESSION_IDLE_MINUTES, CLI_KEY_MAX_DAYS])
    vi.stubEnv(l.env, "");
  await clearLimits();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await clearLimits();
});

async function signIn() {
  const externalId = randomUUID();
  const { token, user } = await createSession("github", {
    externalId,
    email: `${externalId}@lifetimes.example.test`,
    displayName: "Lifetimes test",
  });
  const [row] = await db.select().from(sessions).where(eq(sessions.userId, user.id));
  return { token, userId: user.id, sessionId: row.id, row };
}

/** Move a session's clock back: created and last seen `ms` earlier. */
async function age(sessionId: string, fields: { createdMs?: number; lastSeenMs?: number | null }) {
  const now = Date.now();
  await db
    .update(sessions)
    .set({
      ...(fields.createdMs !== undefined ? { createdAt: new Date(now - fields.createdMs) } : {}),
      ...(fields.lastSeenMs !== undefined
        ? { lastSeenAt: fields.lastSeenMs === null ? null : new Date(now - fields.lastSeenMs) }
        : {}),
    })
    .where(eq(sessions.id, sessionId));
}

const sessionRow = async (id: string) =>
  (await db.select().from(sessions).where(eq(sessions.id, id)))[0];

describe("session lifetimes", () => {
  it("keeps the built-in 30 days / 7 days idle when nothing is set", async () => {
    const s = await signIn();
    expect(s.row.lastSeenAt).not.toBeNull();
    expect(s.row.expiresAt.getTime() - Date.now()).toBeGreaterThan(7 * DAY - HOUR);
    // Unused for 6 days, 29 days old: still valid, and the window slides.
    await age(s.sessionId, { createdMs: 29 * DAY, lastSeenMs: 6 * DAY });
    expect(await validateSession(s.token)).toMatchObject({ id: s.userId });
    const after = await sessionRow(s.sessionId);
    expect(Date.now() - after.lastSeenAt!.getTime()).toBeLessThan(60_000);
    // ...capped by 30 days from sign-in.
    expect(after.expiresAt.getTime()).toBeLessThanOrEqual(after.createdAt.getTime() + 30 * DAY);
  });

  it("ends a session past the max lifetime, including one made before the limit", async () => {
    const s = await signIn();
    await age(s.sessionId, { createdMs: 3 * HOUR, lastSeenMs: 0 });
    expect(await validateSession(s.token)).not.toBeNull();

    await setDeploymentSetting(SESSION_MAX_HOURS.key, 2, null);
    expect(await validateSession(s.token)).toBeNull();
    expect(await sessionRow(s.sessionId)).toBeUndefined();

    // A new session expires within the max lifetime.
    const fresh = await signIn();
    expect(fresh.row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(2 * HOUR);
    expect(await validateSession(fresh.token)).not.toBeNull();
  });

  it("ends a session unused for longer than the idle timeout", async () => {
    await setDeploymentSetting(SESSION_IDLE_MINUTES.key, 30, null);
    const active = await signIn();
    await age(active.sessionId, { lastSeenMs: 10 * 60 * 1000 });
    expect(await validateSession(active.token)).not.toBeNull();
    const slid = await sessionRow(active.sessionId);
    expect(slid.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000);
    expect(slid.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 60 * 1000);

    const idle = await signIn();
    await age(idle.sessionId, { lastSeenMs: 31 * 60 * 1000 });
    expect(await validateSession(idle.token)).toBeNull();
    expect(await sessionRow(idle.sessionId)).toBeUndefined();
  });

  it("counts a session from before the column from its creation", async () => {
    await setDeploymentSetting(SESSION_IDLE_MINUTES.key, 30, null);
    const old = await signIn();
    await age(old.sessionId, { createdMs: 2 * HOUR, lastSeenMs: null });
    expect(await validateSession(old.token)).toBeNull();

    const recent = await signIn();
    await age(recent.sessionId, { createdMs: 5 * 60 * 1000, lastSeenMs: null });
    expect(await validateSession(recent.token)).not.toBeNull();
  });

  it("follows the environment until the app overrides it, where 0 is no limit", async () => {
    vi.stubEnv(SESSION_MAX_HOURS.env, "1");
    const s = await signIn();
    await age(s.sessionId, { createdMs: 2 * HOUR, lastSeenMs: 0 });
    await setDeploymentSetting(SESSION_MAX_HOURS.key, 0, null);
    expect(await validateSession(s.token)).not.toBeNull();
    await setDeploymentSetting(SESSION_MAX_HOURS.key, null, null);
    expect(await validateSession(s.token)).toBeNull();
  });

  it("ignores an environment value out of range", async () => {
    vi.stubEnv(SESSION_IDLE_MINUTES.env, "1");
    const s = await signIn();
    await age(s.sessionId, { lastSeenMs: 10 * 60 * 1000 });
    expect(await validateSession(s.token)).not.toBeNull();
  });
});

describe("CLI key lifetime", () => {
  it("is none by default and dates new CLI keys when set; existing keys are unchanged", async () => {
    const { userId } = await signIn();
    expect(await cliKeyExpiry()).toBeNull();
    const before = await createApiKey(userId, "CLI (before)");

    await setDeploymentSetting(CLI_KEY_MAX_DAYS.key, 30, null);
    const now = new Date();
    const expiry = await cliKeyExpiry(now);
    expect(expiry!.getTime() - now.getTime()).toBe(30 * DAY);

    const after = await createApiKey(userId, "CLI (after)", expiry!);
    expect(after.expiresAt).toBe(expiry!.toISOString());
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, before.tokenId));
    expect(row.expiresAt).toBeNull();
    expect(await validateApiKey(before.token)).not.toBeNull();
    expect(await validateApiKey(after.token)).not.toBeNull();

    vi.stubEnv(CLI_KEY_MAX_DAYS.env, "7");
    await setDeploymentSetting(CLI_KEY_MAX_DAYS.key, null, null);
    expect((await cliKeyExpiry(now))!.getTime() - now.getTime()).toBe(7 * DAY);
  });
});

describe("CLI login", () => {
  /** Finish a CLI login through `/api/auth/cli/token`; the parsed reply. */
  async function cliLogin() {
    const s = await signIn();
    const code = randomBytes(16).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    await getRedisClient().set(
      `cli_code:${code}`,
      JSON.stringify({
        sessionToken: s.token,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      }),
      "EX",
      60,
    );
    const app = await buildRouteTestApp(authRoutes, { user: null });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/cli/token",
        payload: { code, code_verifier: verifier },
      });
      expect(res.statusCode).toBe(200);
      return res.json() as { token: string; tokenId: string; expiresAt?: string | null };
    } finally {
      await app.close();
    }
  }

  it("creates a key that never expires by default, and one that does when set", async () => {
    const plain = await cliLogin();
    expect(plain.expiresAt).toBeNull();
    const [plainRow] = await db.select().from(apiKeys).where(eq(apiKeys.id, plain.tokenId));
    expect(plainRow.expiresAt).toBeNull();

    await setDeploymentSetting(CLI_KEY_MAX_DAYS.key, 14, null);
    const dated = await cliLogin();
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, dated.tokenId));
    expect(dated.expiresAt).toBe(row.expiresAt!.toISOString());
    const days = (row.expiresAt!.getTime() - row.createdAt.getTime()) / DAY;
    expect(days).toBeGreaterThan(13.99);
    expect(days).toBeLessThan(14.01);
    expect(await validateApiKey(dated.token)).not.toBeNull();
    // Still valid before its expiry; once past, refused.
    await db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, dated.tokenId));
    expect(await validateApiKey(dated.token)).toBeNull();
  });
});
