/**
 * Add or remove a directory on a paired machine from Optio — the Machines
 * page and the New work form — instead of `optio local add|remove` on it.
 *
 * The daemon owns the allowlist: it resolves the path on its own disk (`~`,
 * symlinks), checks it exists, saves it to its `local.json`, and answers with
 * the whole new list, which the host row then mirrors. The server never
 * guesses at the machine's filesystem. A daemon started with
 * `--no-remote-dirs` (or from before this existed) doesn't advertise
 * `manageDirs` and is never asked.
 */
import { randomUUID } from "node:crypto";
import type { LocalDaemonMessage, LocalDirOp } from "@optio/shared";
import { logger } from "../logger.js";
import * as relay from "./local-relay.js";
import { setHostDirs, type LocalHostRow } from "./local-host-service.js";

const REQUEST_TIMEOUT_MS = 10_000;

type DirsResult = Extract<LocalDaemonMessage, { type: "dirs-result" }>;

interface Pending {
  hostId: string;
  resolve: (r: DirsResult) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

/** A change the machine couldn't make, with the HTTP status that says why. */
export class HostDirError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 504,
  ) {
    super(message);
  }
}

/** Ask a host's daemon to change its allowlist. Rejects when offline or silent. */
function requestDirChange(hostId: string, op: LocalDirOp, path: string): Promise<DirsResult> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new HostDirError("The machine did not answer in time", 504));
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, { hostId, resolve, timer });
    if (!relay.sendToHost(hostId, { type: "dirs", requestId, op, path })) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(new HostDirError("The machine is offline", 409));
    }
  });
}

/** A daemon answered. Ignored unless the request is pending for that same host. */
export function deliverDirsResult(hostId: string, msg: DirsResult): boolean {
  const p = pending.get(msg.requestId);
  if (!p || p.hostId !== hostId) return false;
  clearTimeout(p.timer);
  pending.delete(msg.requestId);
  p.resolve(msg);
  return true;
}

/**
 * Add (or remove) `path` on `host` and mirror the daemon's new list onto the
 * row. Returns the updated row and the path as the machine resolved it.
 * Throws HostDirError for anything the caller should show.
 */
export async function changeHostDir(
  host: LocalHostRow,
  op: LocalDirOp,
  path: string,
): Promise<{ host: LocalHostRow; path: string }> {
  if (!relay.isHostOnline(host.id)) {
    throw new HostDirError(
      `${host.name} is offline — start \`optio local up\` on it, or run \`optio local ${op} <dir>\` there`,
      409,
    );
  }
  if (!relay.hostCanManageDirs(host.id)) {
    throw new HostDirError(
      `${host.name}'s daemon can't change its directories from here (it runs with --no-remote-dirs, or its CLI predates this) — run \`optio local ${op} <dir>\` on it`,
      409,
    );
  }
  const result = await requestDirChange(host.id, op, path);
  if (result.error || !result.dirs) {
    throw new HostDirError(result.error ?? "The machine sent no directory list", 400);
  }
  const updated = await setHostDirs(host.id, result.dirs);
  if (!updated) throw new HostDirError("That machine was removed", 409);
  logger.info({ hostId: host.id, op, path: result.path ?? path }, "local: host dirs changed");
  return { host: updated, path: result.path ?? path };
}

/** Test-only: forget pending requests. */
export function resetDirRequestsForTests(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
}
