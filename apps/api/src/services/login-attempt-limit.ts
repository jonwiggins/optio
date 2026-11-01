import { createHash } from "node:crypto";
import { getRedisClient } from "./event-bus.js";

/**
 * Failed password sign-ins per account (LDAP), on top of the route's
 * per-address limit: guessing one person's password from many addresses is
 * limited too. The count lives in Redis, so every API replica shares it; it
 * lasts {@link LOGIN_FAILURE_WINDOW_SECS} after the latest failure and a
 * successful sign-in clears it. The directory's own lockout policy still
 * applies on top.
 */
export const LOGIN_FAILURE_LIMIT = 10;
export const LOGIN_FAILURE_WINDOW_SECS = 15 * 60;

/** The key for one account: the username is hashed, never stored as typed. */
function keyOf(provider: string, username: string): string {
  const id = createHash("sha256").update(username.trim().toLowerCase()).digest("hex");
  return `optio:login-failures:${provider}:${id}`;
}

/** Whether this account has failed too often lately to try again yet. */
export async function loginAttemptsExhausted(provider: string, username: string): Promise<boolean> {
  const raw = await getRedisClient().get(keyOf(provider, username));
  return Number(raw ?? 0) >= LOGIN_FAILURE_LIMIT;
}

export async function recordLoginFailure(provider: string, username: string): Promise<void> {
  const redis = getRedisClient();
  const key = keyOf(provider, username);
  await redis.incr(key);
  await redis.expire(key, LOGIN_FAILURE_WINDOW_SECS);
}

export async function clearLoginFailures(provider: string, username: string): Promise<void> {
  await getRedisClient().del(keyOf(provider, username));
}
