import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_VIEW_IN_USE_MS, type LocalServerMessage } from "@optio/shared";
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
  sendToViewer,
  takePendingAttach,
  unregisterDaemon,
  viewerClaim,
  viewerInput,
  viewerPong,
  viewerView,
  type RelaySocket,
} from "./local-relay.js";
import { PROBE_FRESH_MS, PROBE_TIMEOUT_MS } from "./local-grid.js";

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
  pings = 0;
  ping() {
    this.pings++;
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

  it("notifyBrowsers can skip viewers still waiting on their attach", () => {
    const daemon = new FakeSocket();
    registerDaemon("h1", null, daemon);
    const enrolled = new FakeSocket();
    const pending = new FakeSocket();
    attachBrowser("h1", "t1", enrolled);
    const attach = daemon.jsonSent().find((m) => m.type === "attach") as { attachId: string };
    deliverScrollback(attach.attachId, Buffer.alloc(0));
    attachBrowser("h1", "t1", pending);

    notifyBrowsers("t1", { type: "exit", exitCode: 0 }, { pending: false });
    expect(enrolled.sent.map(String)).toContain(JSON.stringify({ type: "exit", exitCode: 0 }));
    expect(pending.sent).toEqual([]);
  });

  it("takePendingAttach hands a refused attach to the caller exactly once", () => {
    const daemon = new FakeSocket();
    registerDaemon("h1", null, daemon);
    const viewer = new FakeSocket();
    attachBrowser("h1", "t1", viewer);
    const attach = daemon.jsonSent().find((m) => m.type === "attach") as { attachId: string };

    const pending = takePendingAttach(attach.attachId);
    expect(pending).toMatchObject({ terminalId: "t1", socket: viewer });
    expect(takePendingAttach(attach.attachId)).toBeNull();
    // Answered: a late scrollback or error for it goes nowhere.
    deliverAttachError(attach.attachId, "Unknown terminal");
    expect(viewer.sent).toEqual([]);

    sendToViewer(viewer, { type: "exit", exitCode: 0 });
    sendToViewer(viewer, Buffer.from("screen"));
    expect(viewer.sent).toEqual([
      JSON.stringify({ type: "exit", exitCode: 0 }),
      Buffer.from("screen"),
    ]);
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
    expect(sizes()).toEqual([{ type: "size", cols: 45, rows: 30, yours: false }]);
  });

  describe("sizing the PTY for the screen in use", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const resizes = (daemon: FakeSocket) =>
      daemon.jsonSent().filter((m) => m.type === "resize") as Array<{
        terminalId: string;
        cols: number;
        rows: number;
      }>;
    const lastSize = (viewer: FakeSocket) =>
      viewer
        .jsonSent()
        .filter((m) => (m as { type: string }).type === "size")
        .at(-1);
    const open = (cols: number, rows: number) => ({
      cols,
      rows,
      visible: true,
      idleMs: 0,
      open: true,
    });

    function attached(daemon: FakeSocket, terminalId: string) {
      const viewer = new FakeSocket();
      attachBrowser("h1", terminalId, viewer);
      const attachId = (
        daemon
          .jsonSent()
          .filter((m) => m.type === "attach")
          .at(-1) as any
      ).attachId;
      deliverScrollback(attachId, Buffer.from("hi"));
      return viewer;
    }

    it("resizes the PTY for a screen that opens it, and tells each viewer whose grid it is", () => {
      const daemon = new FakeSocket();
      registerDaemon("h1", null, daemon);
      const laptop = attached(daemon, "t1");
      viewerView("t1", laptop, open(160, 45));
      expect(resizes(daemon)).toEqual([{ type: "resize", terminalId: "t1", cols: 160, rows: 45 }]);

      const phone = attached(daemon, "t1");
      viewerView("t1", phone, open(48, 30)); // the laptop is in use: the phone watches
      forwardSize("h1", "t1", 160, 45); // the daemon's echo
      expect(resizes(daemon)).toHaveLength(1);
      expect(lastSize(laptop)).toEqual({ type: "size", cols: 160, rows: 45, yours: true });
      expect(lastSize(phone)).toEqual({ type: "size", cols: 160, rows: 45, yours: false });

      viewerClaim("h1", "t1", phone, { cols: 48, rows: 30 }); // "Use this screen"
      forwardSize("h1", "t1", 48, 30);
      expect(lastSize(laptop)).toEqual({ type: "size", cols: 48, rows: 30, yours: false });
      expect(lastSize(phone)).toEqual({ type: "size", cols: 48, rows: 30, yours: true });
    });

    it("pings a quiet holder over its socket and hands over when it never answers", () => {
      const daemon = new FakeSocket();
      registerDaemon("h1", null, daemon);
      const laptop = attached(daemon, "t1");
      viewerView("t1", laptop, open(160, 45));
      vi.advanceTimersByTime(PROBE_FRESH_MS + 1_000);
      const phone = attached(daemon, "t1");
      viewerView("t1", phone, open(48, 30));
      expect(laptop.pings).toBe(1);
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
      expect(resizes(daemon).map((r) => r.cols)).toEqual([160, 48]);

      // A holder that answers keeps it.
      const tab = attached(daemon, "t2");
      viewerView("t2", tab, open(100, 30));
      vi.advanceTimersByTime(PROBE_FRESH_MS + 1_000);
      const other = attached(daemon, "t2");
      viewerView("t2", other, open(48, 30));
      viewerPong("t2", tab);
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
      expect(
        resizes(daemon)
          .filter((r) => r.terminalId === "t2")
          .map((r) => r.cols),
      ).toEqual([100]);
    });

    it("counts typing as use", () => {
      const daemon = new FakeSocket();
      registerDaemon("h1", null, daemon);
      const laptop = attached(daemon, "t1");
      viewerView("t1", laptop, open(160, 45));
      vi.advanceTimersByTime(LOCAL_VIEW_IN_USE_MS - 1_000);
      viewerInput("t1", laptop);
      vi.advanceTimersByTime(2_000);
      viewerView("t1", attached(daemon, "t1"), open(48, 30));
      expect(resizes(daemon)).toHaveLength(1);
    });

    it("forwards a resize from a viewer the relay doesn't track, as before", () => {
      const daemon = new FakeSocket();
      registerDaemon("h1", null, daemon);
      viewerClaim("h1", "t9", new FakeSocket(), { cols: 80, rows: 24 });
      expect(resizes(daemon)).toEqual([{ type: "resize", terminalId: "t9", cols: 80, rows: 24 }]);
    });

    it("forgets a terminal's viewers when the last one leaves or the daemon goes", () => {
      const daemon = new FakeSocket();
      registerDaemon("h1", null, daemon);
      const laptop = attached(daemon, "t1");
      viewerView("t1", laptop, open(160, 45));
      detachBrowser("h1", "t1", laptop);
      // A fresh viewer starts a fresh arbitration: nobody holds the grid.
      const phone = attached(daemon, "t1");
      viewerView("t1", phone, open(48, 30));
      expect(resizes(daemon).map((r) => r.cols)).toEqual([160, 48]);

      unregisterDaemon("h1", daemon);
      viewerView("t1", phone, open(40, 20)); // nothing left to size
      expect(vi.getTimerCount()).toBe(0);
      expect(resizes(daemon).map((r) => r.cols)).toEqual([160, 48]);
    });
  });
});
