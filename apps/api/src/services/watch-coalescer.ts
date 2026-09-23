/**
 * Per-target throttle for Watch frames — the delivery discipline of the iOS
 * Live Activity pushes (apns-service.ts), shared with the Android FCM watch
 * messages (fcm-service.ts) so both platforms see the same rate:
 *
 *   - trailing-edge coalescing: at most one push per target per window; frames
 *     arriving inside the window fold into one pending frame that goes out when
 *     it closes — the latest state wins, an alerting frame is never downgraded
 *     by a later silent one, and `start` / `end` are never downgraded to `update`;
 *   - dedupe: an `update` identical to the last frame delivered (asOf
 *     excluded) is dropped; `start`, `end` and alerting frames always go out;
 *   - `end` opens no window and forgets the target's dedupe state.
 *
 * A "target" is one push token (an ActivityKit token, an FCM device). The
 * owner supplies `send` (build + ship one frame) and `settle` (book the result;
 * `true` when the target was dropped).
 */
import type { WatchState } from "@optio/shared";
import { watchStateHash } from "./apns-payloads.js";

/** Minimum spacing between Watch pushes to one target (≤1 push / s). */
export const WATCH_COALESCE_MS = 1000;

export type WatchFrameEvent = "start" | "update" | "end";

export interface WatchFrame<A> {
  event: WatchFrameEvent;
  state: WatchState;
  /** Present → the frame alerts. */
  alert?: A | null;
}

export interface WatchCoalescerOptions<T, A, R> {
  /** Minimum spacing between pushes to one target. */
  coalesceMs: number;
  /** Build and ship one frame. May throw — nothing is recorded then. */
  send: (target: T, frame: WatchFrame<A>) => Promise<R>;
  /** Book the outcome; resolve `true` when the target was dropped. */
  settle: (key: string, target: T, result: R) => Promise<boolean>;
  /** A timer-driven (coalesced) flush failed. */
  onFlushError: (err: unknown, target: T) => void;
  /** Dedupe identity of a frame; defaults to `<event>:<watchStateHash>`. */
  frameHash?: (frame: WatchFrame<A>) => string;
}

interface Window<T, A> {
  timer: ReturnType<typeof setTimeout>;
  target: T;
  /** Frame to flush when the timer fires (latest wins). */
  pending: WatchFrame<A> | null;
}

/** `start` / `end` survive a later `update` in the same window; otherwise the newest event wins. */
export function mergeWatchEvent(
  pending: WatchFrameEvent | undefined,
  next: WatchFrameEvent,
): WatchFrameEvent {
  if (next !== "update") return next;
  return pending ?? "update";
}

export class WatchCoalescer<T, A, R> {
  /** key → open coalescing window. */
  private windows = new Map<string, Window<T, A>>();
  /** key → dedupe hash of the last frame delivered. */
  private lastHash = new Map<string, string>();
  private readonly frameHash: (frame: WatchFrame<A>) => string;

  constructor(private readonly opts: WatchCoalescerOptions<T, A, R>) {
    this.frameHash = opts.frameHash ?? ((f) => `${f.event}:${watchStateHash(f.state)}`);
  }

  /** Deliver now, or fold into the target's open window. */
  async push(key: string, target: T, frame: WatchFrame<A>): Promise<void> {
    const window = this.windows.get(key);
    if (window) {
      window.pending = {
        state: frame.state,
        event: mergeWatchEvent(window.pending?.event, frame.event),
        alert: frame.alert ?? window.pending?.alert ?? null,
      };
      return;
    }
    await this.deliver(key, target, frame);
  }

  private async deliver(key: string, target: T, frame: WatchFrame<A>): Promise<void> {
    const hash = this.frameHash(frame);
    if (frame.event === "update" && !frame.alert && this.lastHash.get(key) === hash) return;

    const result = await this.opts.send(target, frame);
    this.lastHash.set(key, hash);
    if (await this.opts.settle(key, target, result)) this.lastHash.delete(key);
    if (frame.event === "end") {
      this.lastHash.delete(key);
      return;
    }
    this.openWindow(key, target);
  }

  private openWindow(key: string, target: T): void {
    const timer = setTimeout(() => {
      const w = this.windows.get(key);
      this.windows.delete(key);
      if (!w?.pending) return;
      void this.deliver(key, w.target, w.pending).catch((err) =>
        this.opts.onFlushError(err, w.target),
      );
    }, this.opts.coalesceMs);
    timer.unref?.();
    this.windows.set(key, { timer, target, pending: null });
  }

  /** Cancel pending timers and forget dedupe state (tests, shutdown). */
  reset(): void {
    for (const w of this.windows.values()) clearTimeout(w.timer);
    this.windows.clear();
    this.lastHash.clear();
  }
}
