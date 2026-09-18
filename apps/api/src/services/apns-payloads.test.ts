import { describe, expect, it } from "vitest";
import { appleSeconds, buildWatchState, type WatchItem } from "@optio/shared";
import {
  APNS_MAX_PAYLOAD_BYTES,
  ApnsPayloadTooLargeError,
  buildAlertMessage,
  buildLiveActivityMessage,
  buildLiveActivityStartMessage,
  buildWatchAttributes,
  liveActivityTopic,
  payloadBytes,
  watchStateHash,
} from "./apns-payloads.js";

const NOW = new Date("2026-09-17T12:00:00Z");
const BUNDLE = "dev.optio.ios";

function item(overrides: Partial<WatchItem> = {}): WatchItem {
  return {
    kind: "local",
    id: "t1",
    title: "claude-code",
    mono: "web",
    reason: "Waiting on a permission",
    preview: "Allow Bash(rm -rf node_modules)?",
    since: appleSeconds(NOW),
    state: "needs_you",
    link: "optio://local/t1?compose=1",
    ...overrides,
  };
}

describe("buildAlertMessage", () => {
  it("builds an alert with aps + top-level routing keys", () => {
    const msg = buildAlertMessage(
      {
        title: "Needs you · web",
        body: "Waiting on a permission",
        category: "LOCAL_NEEDS_YOU",
        threadId: "t1",
        url: "optio://local/t1?compose=1",
        kind: "local",
        id: "t1",
        interruptionLevel: "time-sensitive",
      },
      { bundleId: BUNDLE, now: NOW },
    );
    expect(msg.pushType).toBe("alert");
    expect(msg.topic).toBe(BUNDLE);
    expect(msg.priority).toBe(10);
    expect(msg.collapseId).toBe("local-t1");
    expect(msg.expiration).toBe(Math.floor(NOW.getTime() / 1000) + 24 * 3600);
    expect(msg.payload).toEqual({
      aps: {
        alert: { title: "Needs you · web", body: "Waiting on a permission" },
        sound: "default",
        "thread-id": "t1",
        category: "LOCAL_NEEDS_YOU",
        "interruption-level": "time-sensitive",
      },
      url: "optio://local/t1?compose=1",
      kind: "local",
      id: "t1",
    });
  });

  it("omits sound for silent alerts and carries extra keys like prUrl", () => {
    const msg = buildAlertMessage(
      {
        title: "PR opened",
        body: "fix login",
        category: "TASK_PR_OPENED",
        threadId: "task-1",
        url: "optio://tasks/1",
        kind: "task",
        id: "1",
        sound: null,
        mutableContent: true,
        extra: { prUrl: "https://github.com/o/r/pull/1" },
      },
      { bundleId: BUNDLE, now: NOW },
    );
    const aps = msg.payload.aps as Record<string, unknown>;
    expect(aps.sound).toBeUndefined();
    expect(aps["mutable-content"]).toBe(1);
    expect(msg.payload.prUrl).toBe("https://github.com/o/r/pull/1");
  });

  it("honours an explicit collapseId", () => {
    const msg = buildAlertMessage(
      {
        title: "x",
        body: "y",
        category: "AGENT_REPLY",
        threadId: "agent-1",
        url: "optio://agents/1",
        kind: "agent",
        id: "1",
        collapseId: "agent-1-turn-9",
      },
      { bundleId: BUNDLE },
    );
    expect(msg.collapseId).toBe("agent-1-turn-9");
  });

  it("clips a runaway body and never exceeds 4 KB", () => {
    const msg = buildAlertMessage(
      {
        title: "t",
        body: "x".repeat(20_000),
        category: "TEST",
        threadId: "t",
        url: "optio://",
        kind: "test",
        id: "t",
      },
      { bundleId: BUNDLE },
    );
    expect(payloadBytes(msg.payload)).toBeLessThanOrEqual(APNS_MAX_PAYLOAD_BYTES);
  });

  it("throws when extra data pushes the payload past 4 KB", () => {
    expect(() =>
      buildAlertMessage(
        {
          title: "t",
          body: "b",
          category: "TEST",
          threadId: "t",
          url: "optio://",
          kind: "test",
          id: "t",
          extra: { blob: "y".repeat(5000) },
        },
        { bundleId: BUNDLE },
      ),
    ).toThrow(ApnsPayloadTooLargeError);
  });
});

describe("buildLiveActivityMessage", () => {
  const state = buildWatchState({ needsYou: [item()], running: [], now: NOW });

  it("builds a silent update at priority 5 with stale-date and relevance", () => {
    const msg = buildLiveActivityMessage(
      { event: "update", state, now: NOW },
      { bundleId: BUNDLE },
    );
    const ts = Math.floor(NOW.getTime() / 1000);
    expect(msg.pushType).toBe("liveactivity");
    expect(msg.topic).toBe(liveActivityTopic(BUNDLE));
    expect(msg.topic).toBe("dev.optio.ios.push-type.liveactivity");
    expect(msg.priority).toBe(5);
    expect(msg.collapseId).toBeUndefined();
    const aps = msg.payload.aps as Record<string, unknown>;
    expect(aps.timestamp).toBe(ts);
    expect(aps.event).toBe("update");
    expect(aps["stale-date"]).toBe(ts + 120);
    expect(aps["relevance-score"]).toBe(100);
    expect(aps["content-state"]).toEqual(state);
    expect(aps.alert).toBeUndefined();
    expect(aps["dismissal-date"]).toBeUndefined();
  });

  it("alerting updates are priority 10 and carry the alert", () => {
    const msg = buildLiveActivityMessage(
      { event: "update", state, alert: { title: "Needs you", body: "web" }, now: NOW },
      { bundleId: BUNDLE },
    );
    expect(msg.priority).toBe(10);
    const aps = msg.payload.aps as Record<string, unknown>;
    expect(aps.alert).toEqual({ title: "Needs you", body: "web", sound: "default" });
  });

  it("end frames add a dismissal-date and drop stale-date", () => {
    const done = buildWatchState({ needsYou: [], running: [], summary: "Quiet.", now: NOW });
    const msg = buildLiveActivityMessage(
      { event: "end", state: done, now: NOW },
      { bundleId: BUNDLE },
    );
    const ts = Math.floor(NOW.getTime() / 1000);
    const aps = msg.payload.aps as Record<string, unknown>;
    expect(aps.event).toBe("end");
    expect(aps["dismissal-date"]).toBe(ts + 15 * 60);
    expect(aps["stale-date"]).toBeUndefined();
    expect(aps["relevance-score"]).toBe(10);
  });

  it("content-state dates are Apple reference seconds", () => {
    const aps = buildLiveActivityMessage({ event: "update", state, now: NOW }, { bundleId: BUNDLE })
      .payload.aps as { "content-state": { asOf: number; head: { since: number } } };
    // 2026-09-17T12:00:00Z is 811,339,200 s after 2001-01-01T00:00:00Z (1789646400 − 978307200).
    expect(aps["content-state"].asOf).toBe(811_339_200);
    expect(aps["content-state"].head.since).toBe(811_339_200);
  });

  it("stays under 4 KB with a full queue of long previews", () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      item({ id: `t${i}`, preview: "p".repeat(500), title: "t".repeat(100), mono: "m".repeat(60) }),
    );
    const big = buildWatchState({ needsYou: items, running: items, now: NOW });
    const msg = buildLiveActivityMessage({ event: "update", state: big }, { bundleId: BUNDLE });
    expect(payloadBytes(msg.payload)).toBeLessThanOrEqual(APNS_MAX_PAYLOAD_BYTES);
    expect(big.others).toHaveLength(2);
    expect(big.head?.preview).toHaveLength(120);
  });
});

describe("buildLiveActivityStartMessage", () => {
  it("targets WatchAttributes with attributes + content-state", () => {
    const state = buildWatchState({
      needsYou: [],
      running: [item({ state: "working" })],
      now: NOW,
    });
    const msg = buildLiveActivityStartMessage(
      { attributes: buildWatchAttributes("u1", NOW), state, now: NOW },
      { bundleId: BUNDLE },
    );
    expect(msg.pushType).toBe("liveactivity");
    expect(msg.priority).toBe(10);
    const aps = msg.payload.aps as Record<string, unknown>;
    expect(aps.event).toBe("start");
    expect(aps["attributes-type"]).toBe("WatchAttributes");
    expect(aps.attributes).toEqual({ userId: "u1", startedAt: 811_339_200 });
    expect(aps["content-state"]).toEqual(state);
    expect(aps["relevance-score"]).toBe(50);
  });
});

describe("watchStateHash", () => {
  it("ignores asOf so unchanged frames dedupe", () => {
    const a = buildWatchState({ needsYou: [item()], running: [], now: NOW });
    const b = buildWatchState({
      needsYou: [item()],
      running: [],
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(a.asOf).not.toBe(b.asOf);
    expect(watchStateHash(a)).toBe(watchStateHash(b));
    const c = buildWatchState({ needsYou: [], running: [item()], now: NOW });
    expect(watchStateHash(a)).not.toBe(watchStateHash(c));
  });
});
