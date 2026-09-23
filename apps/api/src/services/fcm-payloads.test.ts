import { describe, expect, it } from "vitest";
import { appleSeconds, buildWatchState, type WatchItem, type WatchState } from "@optio/shared";
import {
  FCM_MAX_DATA_BYTES,
  FcmPayloadTooLargeError,
  buildFcmAlertMessage,
  buildFcmWatchMessage,
  fcmDataBytes,
} from "./fcm-payloads.js";
import { buildAlertMessage } from "./apns-payloads.js";

const NOW = new Date("2026-09-17T12:00:00Z");

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

describe("buildFcmAlertMessage", () => {
  const needsYou = {
    title: "Needs you · web",
    subtitle: "claude-code",
    body: "Waiting on a permission · Allow Bash(rm -rf)?",
    category: "LOCAL_NEEDS_YOU" as const,
    threadId: "t1",
    url: "optio://local/t1?compose=1",
    kind: "local" as const,
    id: "t1",
    interruptionLevel: "time-sensitive" as const,
  };

  it("flattens the APNs alert into string data with HIGH priority and a 24 h TTL", () => {
    const msg = buildFcmAlertMessage(needsYou);
    expect(msg).toEqual({
      data: {
        type: "alert",
        category: "LOCAL_NEEDS_YOU",
        title: "Needs you · web",
        subtitle: "claude-code",
        body: "Waiting on a permission · Allow Bash(rm -rf)?",
        url: "optio://local/t1?compose=1",
        kind: "local",
        id: "t1",
        threadId: "t1",
        sound: "default",
        timeSensitive: "1",
        collapseId: "local-t1",
      },
      android: { priority: "HIGH", ttl: "86400s" },
    });
    // No collapse_key: alerts must never replace each other in FCM's store.
    expect(msg.android.collapse_key).toBeUndefined();
    for (const v of Object.values(msg.data)) expect(typeof v).toBe("string");
  });

  it("carries the same routing keys the APNs payload does", () => {
    const apns = buildAlertMessage(needsYou, { bundleId: "dev.optio.ios", now: NOW });
    const fcm = buildFcmAlertMessage(needsYou);
    const aps = apns.payload.aps as Record<string, unknown>;
    expect(fcm.data.url).toBe(apns.payload.url);
    expect(fcm.data.kind).toBe(apns.payload.kind);
    expect(fcm.data.id).toBe(apns.payload.id);
    expect(fcm.data.category).toBe(aps.category);
    expect(fcm.data.threadId).toBe(aps["thread-id"]);
    expect(fcm.data.collapseId).toBe(apns.collapseId);
  });

  it("maps a silent alert to sound none, keeps prUrl and an explicit collapse id, and tags the server", () => {
    const msg = buildFcmAlertMessage(
      {
        title: "PR opened",
        body: "Fix login — acme/web",
        category: "TASK_PR_OPENED",
        threadId: "task-1",
        url: "optio://tasks/1",
        kind: "task",
        id: "1",
        sound: null,
        interruptionLevel: "active",
        collapseId: "task-1",
        extra: { prUrl: "https://github.com/acme/web/pull/7", attempt: 2, from: "nope" },
      },
      { serverId: "srv-a" },
    );
    expect(msg.data).toMatchObject({
      sound: "none",
      prUrl: "https://github.com/acme/web/pull/7",
      collapseId: "task-1",
      serverId: "srv-a",
      attempt: "2",
    });
    expect(msg.data.timeSensitive).toBeUndefined();
    expect(msg.data.subtitle).toBeUndefined();
    // Reserved FCM data keys never ride along.
    expect(msg.data.from).toBeUndefined();
  });

  it("never lets an extra key override a core key", () => {
    const msg = buildFcmAlertMessage({
      ...needsYou,
      extra: { url: "https://evil.example", type: "watch", category: "TEST" },
    });
    expect(msg.data.url).toBe("optio://local/t1?compose=1");
    expect(msg.data.type).toBe("alert");
    expect(msg.data.category).toBe("LOCAL_NEEDS_YOU");
  });

  it("clips a runaway title/body and stays under 4 KB", () => {
    const msg = buildFcmAlertMessage({
      ...needsYou,
      title: "t".repeat(1000),
      subtitle: "s".repeat(1000),
      body: "✓".repeat(20_000),
    });
    expect(msg.data.title).toHaveLength(200);
    expect(msg.data.subtitle).toHaveLength(200);
    expect(msg.data.body).toHaveLength(500);
    expect(fcmDataBytes(msg.data)).toBeLessThanOrEqual(FCM_MAX_DATA_BYTES);
  });

  it("throws when extra data pushes the payload past 4 KB", () => {
    expect(() => buildFcmAlertMessage({ ...needsYou, extra: { blob: "y".repeat(5000) } })).toThrow(
      FcmPayloadTooLargeError,
    );
  });
});

describe("buildFcmWatchMessage", () => {
  const waiting = buildWatchState({ needsYou: [item()], running: [], now: NOW });

  it("wraps the Watch frame as a JSON string, NORMAL priority, collapse_key watch, 1 h TTL", () => {
    const msg = buildFcmWatchMessage({ event: "update", state: waiting });
    expect(msg.android).toEqual({ priority: "NORMAL", ttl: "3600s", collapse_key: "watch" });
    expect(Object.keys(msg.data)).toEqual(["type", "event", "state"]);
    expect(msg.data.type).toBe("watch");
    expect(msg.data.event).toBe("update");
    // The same WatchState the Live Activity carries — Apple reference-date seconds.
    const state = JSON.parse(msg.data.state) as WatchState;
    expect(state).toEqual(waiting);
    expect(state.asOf).toBe(811_339_200);
  });

  it("is HIGH priority when the frame alerts, and carries start / end and the server id", () => {
    const start = buildFcmWatchMessage({
      event: "start",
      state: waiting,
      alert: true,
      serverId: "srv-a",
    });
    expect(start.android.priority).toBe("HIGH");
    expect(start.data).toMatchObject({ event: "start", serverId: "srv-a" });

    const done = buildWatchState({ needsYou: [], running: [], summary: "Quiet.", now: NOW });
    const end = buildFcmWatchMessage({ event: "end", state: done });
    expect(end.data.event).toBe("end");
    expect(end.android.priority).toBe("NORMAL");
    expect(JSON.parse(end.data.state)).toMatchObject({ phase: "done", summary: "Quiet." });
  });

  it("fits a full queue of long ASCII rows untouched", () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      item({
        id: `t${i}`,
        preview: "p".repeat(500),
        title: "t".repeat(100),
        mono: "m".repeat(60),
        reason: "r".repeat(80),
        prUrl: "https://github.com/jonwiggins/optio/pull/" + "9".repeat(60),
        snoozedUntil: appleSeconds(NOW),
        source: "local-terminal",
        when: "on a trigger",
        where: { target: "machine", detail: "MacBook Pro · " + "/deep".repeat(60) },
        who: "claude-code",
        then: "waits-for-me",
        statusLabel: "needs you",
      }),
    );
    const big = buildWatchState({
      needsYou: items,
      running: items,
      counts: { waiting: 999, recurring: 999, agents: 999 },
      now: NOW,
    });
    const msg = buildFcmWatchMessage({ event: "update", state: big, serverId: "x".repeat(100) });
    expect(fcmDataBytes(msg.data)).toBeLessThanOrEqual(FCM_MAX_DATA_BYTES);
    expect(JSON.parse(msg.data.state)).toEqual(big);
  });

  it("sheds previews, then extra rows, from a frame over 4 KB instead of failing", () => {
    // Multi-byte text blows the byte budget even though every field is char-clamped.
    const items = Array.from({ length: 3 }, (_, i) =>
      item({
        id: `t${i}`,
        title: "é".repeat(100),
        preview: "✓".repeat(500),
        reason: "界".repeat(80),
        mono: "界".repeat(60),
        prUrl: "https://github.com/jonwiggins/optio/pull/" + "9".repeat(60),
        source: "local-terminal",
        when: "on a trigger",
        where: { target: "machine", detail: "界".repeat(60) },
        who: "claude-code",
        then: "waits-for-me",
        statusLabel: "needs you",
      }),
    );
    const heavy = buildWatchState({ needsYou: items, running: [], now: NOW });
    expect(Buffer.byteLength(JSON.stringify(heavy))).toBeGreaterThan(FCM_MAX_DATA_BYTES);

    const msg = buildFcmWatchMessage({ event: "update", state: heavy });
    expect(fcmDataBytes(msg.data)).toBeLessThanOrEqual(FCM_MAX_DATA_BYTES);
    const sent = JSON.parse(msg.data.state) as WatchState;
    // Counts always survive; detail goes first.
    expect(sent.needsYouCount).toBe(3);
    expect(sent.phase).toBe("waiting");
    expect(sent.head?.id).toBe(heavy.head?.id);
    expect(sent.others.every((o) => !o.preview)).toBe(true);
  });
});
