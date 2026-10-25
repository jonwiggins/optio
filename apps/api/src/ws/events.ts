import type { FastifyInstance } from "fastify";
import { createSubscriber } from "../services/event-bus.js";
import { authenticateWs } from "./ws-auth.js";
import { getRecentEvents } from "../services/task-service.js";
import { acceptWs } from "./ws-connection.js";
import type { Actor } from "../services/ownership.js";
import type { SessionUser } from "../services/session-service.js";
import { canSeeWork } from "../services/work-visibility.js";
import { wsActor, wsActorIn } from "./ws-actor.js";
import { frameOwner, type FrameSubject, type WorkOwner } from "./frame-owner.js";

/** The fields of an events-channel frame the filter reads. */
interface FrameHeader {
  type?: string;
  userId?: string | null;
  workspaceId?: string | null;
  ownerUserId?: string | null;
  ownerTeamId?: string | null;
  createdBy?: string | null;
  taskId?: string;
  workflowRunId?: string;
  prReviewId?: string;
  agentId?: string;
}

/**
 * Log lines: each kind has its own socket, which checks who may see the
 * work (`/ws/logs/:taskId`, `/ws/workflow-runs/:id/logs`,
 * `/ws/pr-reviews/:id/logs`, `/ws/persistent-agents/:id/events`) — never
 * this one.
 */
const LOG_FRAMES = new Set([
  "task:log",
  "workflow_run:log",
  "pr_review_run:log",
  "persistent_agent:log",
]);

/**
 * Whether a frame on the shared `optio:events` channel may reach `actor`.
 * The channel fans out to every authenticated user, so three kinds of frame
 * are filtered:
 *
 * - `local:changed` nudges carry their owner's terminal / host / user id:
 *   only that user gets them.
 * - Log lines (`LOG_FRAMES`) never.
 * - A frame about work says whose it is (`ownerUserId`, and `ownerTeamId` /
 *   `createdBy`; task-service.ts `workOwnerFields`, or `frameReaches` looks
 *   them up): it reaches who may see that work — the rule of
 *   GET /api/tasks/:id (`canSeeWork`).
 *
 * Anything else is no one's in particular and passes.
 */
export function canSeeFrame(evt: FrameHeader, actor: Actor): boolean {
  if (evt.type === "local:changed") return !evt.userId || evt.userId === actor.userId;
  if (LOG_FRAMES.has(evt.type ?? "")) return false;
  if (!("ownerUserId" in evt)) return true;
  return canSeeWork(evt, actor);
}

/** The work a frame is about, if any. */
function subjectOf(evt: FrameHeader): FrameSubject | null {
  if (evt.taskId) return { kind: "run", id: evt.taskId };
  if (evt.workflowRunId) return { kind: "run", id: evt.workflowRunId };
  if (evt.prReviewId) return { kind: "pr-review", id: evt.prReviewId };
  if (evt.agentId) return { kind: "agent", id: evt.agentId };
  return null;
}

/** Whether a frame says whose its work is and where, all of it (`workOwnerFields`). */
const carriesOwner = (evt: FrameHeader): evt is FrameHeader & WorkOwner =>
  "workspaceId" in evt && "ownerUserId" in evt && "ownerTeamId" in evt && "createdBy" in evt;

/** Who is listening: the socket's Actor, and the same user in another workspace. */
export interface FrameViewer {
  actor: Actor;
  actorIn(workspaceId: string | null): Promise<Actor | null>;
}

/**
 * Whether a live frame reaches `viewer`. A frame about work that doesn't
 * say whose it is and where — a stall, a pending reason, a comment, a
 * message, a Job run's, a review's or an agent's frames — gets its owner
 * and workspace looked up (frame-owner.ts, one cache for every socket).
 * Then it reaches the user only from a workspace they belong to, and only
 * as the rule there allows (`canSeeFrame`).
 *
 * A frame whose owner can't be told — its row is gone, or the lookup
 * failed — reaches only an admin, who may see all the work in their
 * workspace. Anyone else could be shown someone's private work (a
 * message, a stall's last log line); missing the frame costs them a live
 * refresh at most.
 */
export async function frameReaches(evt: FrameHeader, viewer: FrameViewer): Promise<boolean> {
  const subject = LOG_FRAMES.has(evt.type ?? "") ? null : subjectOf(evt);
  if (!subject) return canSeeFrame(evt, viewer.actor);
  let owner: WorkOwner | null;
  try {
    owner = carriesOwner(evt) ? evt : await frameOwner(subject);
  } catch {
    owner = null;
  }
  if (!owner) return viewer.actor.isAdmin;
  const actor = await viewer.actorIn(owner.workspaceId);
  if (!actor) return false;
  return canSeeFrame(
    {
      ...evt,
      ownerUserId: owner.ownerUserId,
      ownerTeamId: owner.ownerTeamId,
      createdBy: owner.createdBy,
    },
    actor,
  );
}

/**
 * The viewer behind a socket. A frame from the socket's own workspace is
 * judged by its Actor; one from another workspace by the user's Actor
 * there, looked up once per socket — none when they aren't a member (nor
 * for work with no workspace, which GET /api/tasks/:id hides from anyone
 * who has one).
 */
function viewerOf(user: SessionUser, actor: Actor): FrameViewer {
  const others = new Map<string, Promise<Actor | null>>();
  return {
    actor,
    actorIn(workspaceId) {
      if (workspaceId === actor.workspaceId) return Promise.resolve(actor);
      if (!workspaceId) return Promise.resolve(null);
      let found = others.get(workspaceId);
      if (!found) {
        found = wsActorIn(user, workspaceId).catch(() => {
          others.delete(workspaceId);
          return null;
        });
        others.set(workspaceId, found);
      }
      return found;
    },
  };
}

/** Whether a raw frame needs parsing for `frameReaches` (some don't). */
const mayBePrivate = (message: string) =>
  message.includes('"local:changed"') ||
  message.includes('"ownerUserId"') ||
  /"(taskId|workflowRunId|prReviewId|agentId)"/.test(message);

/** `frameReaches` for a raw frame; one that can't be parsed is one whose owner can't be told. */
async function messageReaches(message: string, viewer: FrameViewer): Promise<boolean> {
  if (!mayBePrivate(message)) return true;
  let evt: FrameHeader;
  try {
    evt = JSON.parse(message) as FrameHeader;
  } catch {
    return viewer.actor.isAdmin;
  }
  return frameReaches(evt, viewer);
}

export async function eventsWs(app: FastifyInstance) {
  app.get("/ws/events", { websocket: true }, async (socket, req) => {
    // Synchronously, before any await (see ws-connection.ts).
    const conn = acceptWs(socket, req);
    if (!conn) return;

    const user = await authenticateWs(socket, req);
    if (!user) return conn.discard();

    // Who is listening: the same rule filters the catch-up and the live frames.
    const actor = await wsActor(user);
    const viewer = viewerOf(user, actor);

    // Send catch-up: recent state-change events so reconnecting clients stay in sync
    // (of the work this person may see, as the live frames below).
    try {
      const recentEvents = await getRecentEvents({
        limit: 20,
        workspaceId: actor.workspaceId,
        visibleTo: actor,
      });
      for (const event of recentEvents) {
        socket.send(
          JSON.stringify({
            type: "task:state_changed",
            taskId: event.taskId,
            fromState: event.fromState,
            toState: event.toState,
            timestamp: event.createdAt,
            catchUp: true,
          }),
        );
      }
    } catch {
      // ignore catch-up errors — still subscribe to live events
    }
    if (conn.closed) return;

    const subscriber = createSubscriber();
    const channel = "optio:events";
    subscriber.subscribe(channel);

    // Frames go out in the order they came, whether or not one waited on a
    // lookup. A frame the filter fails on is dropped.
    let queue: Promise<void> = Promise.resolve();
    subscriber.on("message", (_ch: string, message: string) => {
      queue = queue
        .then(async () => {
          if ((await messageReaches(message, viewer)) && !conn.closed) socket.send(message);
        })
        .catch(() => {});
    });

    conn.onClose(() => {
      subscriber.unsubscribe(channel);
      subscriber.disconnect();
    });
    // Server → client only: client frames are ignored.
    conn.ready(() => {});
  });
}
