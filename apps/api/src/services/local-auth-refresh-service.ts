/**
 * Refresh the cluster's CLAUDE_CODE_OAUTH_TOKEN from a paired machine's own
 * Claude Code login, through the Optio Local daemon — no Keychain one-liner,
 * no paste. The server asks the daemon for the machine's access token
 * (`credentials` frame), validates it against Anthropic, and stores it the
 * way the Secrets page would. Two ways in:
 *
 *  - explicit: POST /api/auth/claude-token/refresh-from-host (admin, own host)
 *  - automatic: the token-validation worker finds the stored token expired,
 *    or a capable daemon connects while it is known-expired — the server
 *    refreshes on its own and only shows the paste banner if that fails.
 *
 * Only a host owned by a deployment admin (or any host in auth-disabled dev)
 * may supply a token: it is the same power the global Secrets page gates on deployment admin.
 *
 * The token never crosses Redis. With several API instances the whole
 * refresh — ask the daemon, validate, store — runs on the instance its
 * daemon is connected to (an owner task, `relay.runOnOwner`), and only the
 * outcome travels back to the instance that asked.
 */
import { randomUUID } from "node:crypto";
import type { LocalDaemonMessage } from "@optio/shared";
import { logger } from "../logger.js";
import * as relay from "./local-relay.js";
import { HostRequests } from "./local-host-requests.js";
import { getHost, type LocalHostRow } from "./local-host-service.js";
import { isAuthDisabled } from "./oauth/index.js";
import {
  hasDeploymentAdmin,
  isDeploymentAdmin,
  isFoundingWorkspaceAdmin,
} from "./sign-in-config-service.js";
import { invalidateCredentialsCache, invalidateUsageCache } from "./auth-service.js";
import { storeSecret } from "./secret-service.js";
import { publishEvent } from "./event-bus.js";
import { validateClaudeToken, recordTokenValidation } from "../workers/token-validation-worker.js";
import { like } from "drizzle-orm";
import { db } from "../db/client.js";
import { leases } from "../db/schema.js";
import { acquireLease } from "./lease-service.js";

/**
 * A daemon whose own login has expired runs `claude` once to renew it before
 * answering (up to 90s there), so the wait is generous.
 */
const REQUEST_TIMEOUT_MS = 120_000;
/** Don't hammer a machine whose token is also stale: one automatic attempt per host per window. */
const AUTO_RETRY_WINDOW_MS = 10 * 60_000;

type CredentialsResult = Extract<LocalDaemonMessage, { type: "credentials-result" }>;

const credentials = new HostRequests<CredentialsResult>({
  timeoutMs: REQUEST_TIMEOUT_MS,
  timeoutError: () => new Error("The machine did not answer in time"),
  offlineError: () => new Error("The machine is offline"),
});

/** The owner task that refreshes the token from a daemon connected to this instance. */
const REFRESH_TASK = "refresh-claude-token";

/**
 * One automatic attempt per host per window, across every API instance: a
 * lease nobody renews (each claim names a fresh holder, so it is taken only
 * once the last one lapsed).
 */
const AUTO_ATTEMPT_LEASE = (hostId: string) => `claude-auto-refresh:${hostId}`;
function claimAutoAttempt(hostId: string): Promise<boolean> {
  return acquireLease(AUTO_ATTEMPT_LEASE(hostId), AUTO_RETRY_WINDOW_MS, randomUUID());
}

export type RefreshOutcome = { ok: true; hostId: string } | { ok: false; error: string };

/**
 * Ask a host's daemon for its Claude access token. Only ever sent to a
 * daemon connected to this instance (the owner task's side). Rejects when
 * offline or silent.
 */
function requestCredentials(hostId: string): Promise<CredentialsResult> {
  return credentials.ask(hostId, (requestId) => ({ type: "credentials", requestId }));
}

/** A daemon answered. Ignored unless the request is pending for that same host. */
export function deliverCredentialsResult(hostId: string, msg: CredentialsResult): boolean {
  return credentials.deliver(hostId, msg);
}

/** Whether this host's owner is allowed to seed the cluster's Claude token. */
export async function hostMayRefreshToken(host: LocalHostRow): Promise<boolean> {
  if (isAuthDisabled()) return true;
  return (
    !!host.userId &&
    ((await isDeploymentAdmin({ id: host.userId })) ||
      (!(await hasDeploymentAdmin()) && (await isFoundingWorkspaceAdmin(host.userId))))
  );
}

/**
 * Pull the token from `host`, validate it, store it — on the instance its
 * daemon is connected to. `trigger` is for the log line. Never throws:
 * every failure is an outcome the UI can show.
 */
export async function refreshClaudeTokenFromHost(
  host: LocalHostRow,
  trigger: "manual" | "auto",
): Promise<RefreshOutcome> {
  let ran: Awaited<ReturnType<typeof relay.runOnOwner>>;
  try {
    ran = await relay.runOnOwner(host.id, REFRESH_TASK, { trigger }, REQUEST_TIMEOUT_MS + 30_000);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (ran === "offline") return { ok: false, error: "That machine is offline" };
  if (ran === "timeout") return { ok: false, error: "The machine did not answer in time" };
  const outcome = ran.result as RefreshOutcome | null;
  return outcome && typeof outcome === "object" && "ok" in outcome
    ? outcome
    : { ok: false, error: "The machine's API instance sent no outcome" };
}

/** The refresh itself, on the instance the host's daemon is connected to. */
async function refreshHere(hostId: string, trigger: "manual" | "auto"): Promise<RefreshOutcome> {
  const host = await getHost(hostId);
  if (!host) return { ok: false, error: "That machine was removed" };
  if (!(await hostMayRefreshToken(host))) {
    return { ok: false, error: "Only a deployment admin’s machine may replace the shared token" };
  }
  const caps = await relay.hostCapabilities(host.id);
  if (!caps?.claudeCredentials) {
    return {
      ok: false,
      error: caps
        ? "That machine has no Claude Code login to share — run `claude` on it and sign in"
        : "That machine is offline",
    };
  }
  let result: CredentialsResult;
  try {
    result = await requestCredentials(host.id);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!result.token) {
    return { ok: false, error: result.error ?? "The machine sent no token" };
  }
  const token = result.token.trim();
  if (!/^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/.test(token) || token.length > 1024) {
    return { ok: false, error: "The machine sent something that is not a Claude OAuth token" };
  }
  const validation = await validateClaudeToken(token);
  if (!validation.valid) {
    return {
      ok: false,
      error: `The token on ${host.name} is expired too and \`claude\` there could not renew it — sign in again on that machine`,
    };
  }
  // Global scope: that's what the token-validation worker, the usage probe,
  // and agent pods read (the same row scripts/update-claude-auth.sh writes).
  await storeSecret("CLAUDE_CODE_OAUTH_TOKEN", token, "global", null, null);
  invalidateCredentialsCache();
  invalidateUsageCache();
  await recordTokenValidation({ valid: true, tokenExists: true }).catch(() => {});
  await publishEvent({ type: "auth:status_changed", timestamp: new Date().toISOString() }).catch(
    () => {},
  );
  logger.info(
    { hostId: host.id, host: host.name, trigger },
    "Claude OAuth token refreshed from a paired machine",
  );
  return { ok: true, hostId: host.id };
}

relay.onOwnerTask(REFRESH_TASK, (hostId, args) =>
  refreshHere(hostId, args.trigger === "auto" ? "auto" : "manual"),
);

/**
 * Try every online, credential-bearing host whose owner may seed the token
 * (each at most once per window). True when one of them worked.
 */
export async function autoRefreshClaudeToken(reason: string): Promise<boolean> {
  for (const { hostId } of await relay.hostsWithClaudeCredentials()) {
    if (!(await claimAutoAttempt(hostId))) continue;
    const host = await getHost(hostId);
    if (!host || !(await hostMayRefreshToken(host))) continue;
    const outcome = await refreshClaudeTokenFromHost(host, "auto");
    if (outcome.ok) return true;
    logger.info({ hostId, reason, error: outcome.error }, "automatic Claude token refresh skipped");
  }
  return false;
}

/**
 * A capable daemon just connected: if the stored token is known-expired (or
 * missing), refresh from it right away so "start the daemon" is the fix.
 */
export async function maybeRefreshOnHello(host: LocalHostRow): Promise<void> {
  const { getCachedTokenValidation } = await import("../workers/token-validation-worker.js");
  const cached = await getCachedTokenValidation();
  if (!cached || (cached.valid && cached.tokenExists)) return;
  if (!(await hostMayRefreshToken(host))) return;
  if (!(await claimAutoAttempt(host.id))) return;
  await refreshClaudeTokenFromHost(host, "auto");
}

export async function resetAuthRefreshForTests(): Promise<void> {
  credentials.reset();
  await db.delete(leases).where(like(leases.key, "claude-auto-refresh:%"));
}
