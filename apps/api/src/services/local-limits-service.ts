import { randomUUID } from "node:crypto";
import type { LocalDaemonMessage, LocalHostAgentLimits } from "@optio/shared";
import * as relay from "./local-relay.js";
import { handleAgentLimits, type LocalHostRow } from "./local-host-service.js";

/**
 * The refresh button on a machine's Codex usage pill: ask its daemon to read
 * Codex's limits now (Codex's app server answers `account/rateLimits/read`;
 * the session log only moves when Codex runs). Mirrors local-dirs-service's
 * request / answer pairing.
 */

const REQUEST_TIMEOUT_MS = 30_000;

type LimitsResult = Extract<LocalDaemonMessage, { type: "limits-refresh-result" }>;

interface Pending {
  hostId: string;
  resolve: (r: LimitsResult) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

/** Why the limits couldn't be refreshed, with the HTTP status that says so. */
export class LimitsRefreshError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 502 | 504,
  ) {
    super(message);
  }
}

/** A daemon answered. Ignored unless the request is pending for that same host. */
export function deliverLimitsResult(hostId: string, msg: LimitsResult): boolean {
  const p = pending.get(msg.requestId);
  if (!p || p.hostId !== hostId) return false;
  clearTimeout(p.timer);
  pending.delete(msg.requestId);
  p.resolve(msg);
  return true;
}

export async function refreshHostLimits(host: LocalHostRow): Promise<LocalHostAgentLimits> {
  if (!relay.isHostOnline(host.id)) {
    throw new LimitsRefreshError(`${host.name} is offline — start \`optio local up\` on it`, 409);
  }
  if (!relay.hostCanRefreshLimits(host.id)) {
    throw new LimitsRefreshError(
      `Optio Local on ${host.name} can't refresh limits yet — update it and restart \`optio local up\``,
      409,
    );
  }
  const result = await new Promise<LimitsResult>((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new LimitsRefreshError("The machine did not answer in time", 504));
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, { hostId: host.id, resolve, timer });
    if (!relay.sendToHost(host.id, { type: "limits-refresh", requestId })) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(new LimitsRefreshError(`${host.name} is offline`, 409));
    }
  });
  if (result.error) throw new LimitsRefreshError(result.error, 502);
  const limits = result.limits ?? {};
  // The daemon also sends an agent-limits frame; store these too so the
  // response and the host row agree even if that frame is still in flight.
  await handleAgentLimits(host.id, limits);
  return limits;
}
