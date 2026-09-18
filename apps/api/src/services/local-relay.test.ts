import { beforeEach, describe, expect, it } from "vitest";
import type { LocalServerMessage } from "@optio/shared";
import {
  attachBrowser,
  deliverAttachError,
  deliverScrollback,
  detachBrowser,
  forwardOutput,
  forwardSize,
  isHostOnline,
  notifyBrowsers,
  registerDaemon,
  resetRelayForTests,
  sendToHost,
  unregisterDaemon,
  type RelaySocket,
} from "./local-relay.js";

class FakeSocket implements RelaySocket {
  readyState = 1;
  sent: Array<string | Buffer> = [];
  closedWith: { code?: number; reason?: string } | null = null;
  send(data: string | Buffer) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closedWith = { code, reason };
  }
  jsonSent(): LocalServerMessage[] {
    return this.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d));
  }
}

describe("local-relay", () => {
  beforeEach(() => resetRelayForTests());

  it("tracks daemon liveness and delivers messages", () => {
    const daemon = new FakeSocket();
    expect(isHostOnline("h1")).toBe(false);
    expect(sendToHost("h1", { type: "pong" })).toBe(false);

    registerDaemon("h1", null, daemon);
    expect(isHostOnline("h1")).toBe(true);
    expect(sendToHost("h1", { type: "pong" })).toBe(true);
    expect(daemon.jsonSent()).toEqual([{ type: "pong" }]);
  });

  it("replaces an older daemon connection for the same host", () => {
    const old = new FakeSocket();
    const fresh = new FakeSocket();
    registerDaemon("h1", null, old);
    registerDaemon("h1", null, fresh);
    expect(old.closedWith?.code).toBe(4000);

    // The stale connection's close must not evict the replacement.
    expect(unregisterDaemon("h1", old)).toBe(false);
    expect(isHostOnline("h1")).toBe(true);
  });

  it("routes scrollback to the requesting viewer only, then live output to all", () => {
    const daemon = new FakeSocket();
    registerDaemon("h1", null, daemon);

    const viewerA = new FakeSocket();
    expect(attachBrowser("h1", "t1", viewerA)).toBe(true);
    const attachA = daemon.jsonSent().find((m) => m.type === "attach") as {
      type: "attach";
      attachId: string;
    };
    expect(attachA).toBeDefined();

    // Live output before the snapshot lands is not delivered to A.
    forwardOutput("h1", "t1", Buffer.from("early"));
    expect(viewerA.sent).toHaveLength(0);

    deliverScrollback(attachA.attachId, Buffer.from("history"));
    expect(viewerA.sent.map(String)).toEqual(["history"]);

    forwardOutput("h1", "t1", Buffer.from("live"));
    expect(viewerA.sent.map(String)).toEqual(["history", "live"]);

    // A daemon on a different host cannot inject into t1's viewer.
    forwardOutput("attacker-host", "t1", Buffer.from("evil"));
    expect(viewerA.sent.map(String)).toEqual(["history", "live"]);

    // Second viewer: gets its own snapshot; A is not re-sent history.
    const viewerB = new FakeSocket();
    attachBrowser("h1", "t1", viewerB);
    const attachB = daemon
      .jsonSent()
      .filter((m) => m.type === "attach")
      .at(-1) as { attachId: string };
    deliverScrollback(attachB.attachId, Buffer.from("historylive"));
    forwardOutput("h1", "t1", Buffer.from("more"));
    expect(viewerA.sent.map(String)).toEqual(["history", "live", "more"]);
    expect(viewerB.sent.map(String)).toEqual(["historylive", "more"]);
  });

  it("sends detach only when the last viewer (and no pending attach) leaves", () => {
    const daemon = new FakeSocket();
    registerDaemon("h1", null, daemon);
    const viewerA = new FakeSocket();
    const viewerB = new FakeSocket();
    attachBrowser("h1", "t1", viewerA);
    attachBrowser("h1", "t1", viewerB);
    const attaches = daemon.jsonSent().filter((m) => m.type === "attach") as Array<{
      attachId: string;
    }>;
    deliverScrollback(attaches[0].attachId, Buffer.alloc(0));

    // A enrolled, B still pending: A detaching must not send detach.
    detachBrowser("h1", "t1", viewerA);
    expect(daemon.jsonSent().filter((m) => m.type === "detach")).toHaveLength(0);

    deliverScrollback(attaches[1].attachId, Buffer.alloc(0));
    detachBrowser("h1", "t1", viewerB);
    expect(daemon.jsonSent().filter((m) => m.type === "detach")).toHaveLength(1);
  });

  it("delivers attach errors to the waiting viewer", () => {
    const daemon = new FakeSocket();
    registerDaemon("h1", null, daemon);
    const viewer = new FakeSocket();
    attachBrowser("h1", "t1", viewer);
    const attach = daemon.jsonSent().find((m) => m.type === "attach") as { attachId: string };
    deliverAttachError(attach.attachId, "no such terminal");
    expect(viewer.sent.map(String)).toEqual([
      JSON.stringify({ type: "error", message: "no such terminal" }),
    ]);
    // Not enrolled for output afterwards.
    forwardOutput("h1", "t1", Buffer.from("x"));
    expect(viewer.sent).toHaveLength(1);
  });

  it("closes viewers with 4503 when the daemon disconnects", () => {
    const daemon = new FakeSocket();
    registerDaemon("h1", null, daemon);
    const viewer = new FakeSocket();
    attachBrowser("h1", "t1", viewer);
    const attach = daemon.jsonSent().find((m) => m.type === "attach") as { attachId: string };
    deliverScrollback(attach.attachId, Buffer.alloc(0));

    expect(unregisterDaemon("h1", daemon)).toBe(true);
    expect(viewer.closedWith?.code).toBe(4503);
    expect(isHostOnline("h1")).toBe(false);
  });

  it("notifyBrowsers reaches enrolled and pending viewers", () => {
    const daemon = new FakeSocket();
    registerDaemon("h1", null, daemon);
    const enrolled = new FakeSocket();
    const pending = new FakeSocket();
    attachBrowser("h1", "t1", enrolled);
    const attach = daemon.jsonSent().find((m) => m.type === "attach") as { attachId: string };
    deliverScrollback(attach.attachId, Buffer.alloc(0));
    attachBrowser("h1", "t1", pending);

    notifyBrowsers("t1", { type: "exit", exitCode: 0 });
    const expected = JSON.stringify({ type: "exit", exitCode: 0 });
    expect(enrolled.sent.map(String)).toContain(expected);
    expect(pending.sent.map(String)).toContain(expected);
  });

  it("forwardSize reaches every viewer, only from the host that owns the terminal", () => {
    const daemon = new FakeSocket();
    registerDaemon("h1", null, daemon);
    const viewer = new FakeSocket();
    attachBrowser("h1", "t1", viewer);
    const attachId = (daemon.jsonSent().find((m) => m.type === "attach") as any).attachId;
    deliverScrollback(attachId, Buffer.from("hi"));

    // Viewers get stream messages, not daemon-bound ones.
    const sizes = () => viewer.jsonSent().filter((m) => (m as { type: string }).type === "size");
    forwardSize("h2", "t1", 45, 30); // another host can't speak for t1
    expect(sizes()).toHaveLength(0);

    forwardSize("h1", "t1", 45, 30);
    expect(sizes()).toEqual([{ type: "size", cols: 45, rows: 30 }]);
  });
});
