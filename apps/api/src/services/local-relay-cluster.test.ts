/**
 * The relay across instances, with the bus and the leases in memory: what
 * the owner of a host does with frames from other instances (attach,
 * snapshot, output, size, input, resize, requests and their answers,
 * handing the host over), and what an instance with a viewer of a daemon
 * owned elsewhere does (attach through the owner, take only the owner's
 * frames, report its viewers, reconnect them when the owner changes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What this instance put on the bus. */
interface Published {
  channel: string;
  header: Record<string, unknown>;
  payload?: Buffer;
}
const { leases, published, listeners, direct, ctl } = vi.hoisted(() => ({
  leases: new Map<string, string>(),
  published: [] as Published[],
  listeners: new Map<string, Set<(m: unknown) => void>>(),
  direct: new Map<string, (m: unknown) => void>(),
  ctl: {
    /** How the owner answers a request: ack, no ack in time, or nobody listening. */
    ask: "ok",
    /** Holds a seize until released (a claim in flight). */
    seizeGate: null as Promise<void> | null,
    /** Holds an `attach` publish until released. */
    attachGate: null as Promise<void> | null,
    /** How many lease reads the heartbeat made. */
    holderReads: 0,
  },
}));
vi.mock("./lease-service.js", () => ({
  leaseHolder: async (key: string) => leases.get(key) ?? null,
  leaseHolders: async (keys: string[]) => {
    ctl.holderReads++;
    return new Map(keys.filter((k) => leases.has(k)).map((k) => [k, leases.get(k)!]));
  },
  seizeLease: async (key: string, _ttl: number, holder: string) => {
    if (ctl.seizeGate) await ctl.seizeGate;
    leases.set(key, holder);
  },
  renewLease: async (key: string, _ttl: number, holder: string) => leases.get(key) === holder,
  releaseLease: async (key: string, holder: string) => {
    if (leases.get(key) === holder) leases.delete(key);
  },
}));

vi.mock("../db/client.js", () => {
  const chain = () => ({ set: () => ({ where: async () => [] }) });
  return {
    db: {
      update: chain,
      select: () => ({ from: () => ({ where: async () => [] }) }),
      execute: async () => [],
    },
  };
});

vi.mock("./local-bus.js", async () => {
  const actual = await vi.importActual<typeof import("./local-bus.js")>("./local-bus.js");
  const publishCount = async (
    channel: string,
    header: Record<string, unknown>,
    payload?: Buffer,
  ) => {
    if (header.k === "attach" && ctl.attachGate) await ctl.attachGate;
    published.push({ channel, header, payload });
    return 1;
  };
  return {
    ...actual,
    localBus: {
      started: true,
      listen(channel: string, handler: (m: unknown) => void) {
        let set = listeners.get(channel);
        if (!set) listeners.set(channel, (set = new Set()));
        set.add(handler);
        return {
          ready: Promise.resolve(true),
          close: () => {
            set.delete(handler);
            if (set.size === 0) listeners.delete(channel);
          },
        };
      },
      publishCount,
      async publish(channel: string, header: Record<string, unknown>, payload?: Buffer) {
        return (await publishCount(channel, header, payload)) !== null;
      },
      async ask(channel: string, header: Record<string, unknown>, _t: number, payload?: Buffer) {
        if (ctl.ask === "unheard") return "unheard";
        published.push({ channel, header, payload });
        if (ctl.ask === "timeout") return "timeout";
        return {
          header: { k: "reply", ok: true },
          payload: Buffer.from(JSON.stringify({ ran: header.task ?? null })),
          channel: "",
        };
      },
      async reply(
        to: { header: Record<string, unknown> },
        header: Record<string, unknown>,
        payload?: Buffer,
      ) {
        published.push({
          channel: `reply:${String(to.header.rt)}`,
          header: { ...header, rid: to.header.rid },
          payload,
        });
        return true;
      },
      async sendDirect(instance: string, header: Record<string, unknown>, payload?: Buffer) {
        published.push({ channel: `direct:${instance}`, header, payload });
        return true;
      },
      onDirect(kind: string, handler: (m: unknown) => void) {
        direct.set(kind, handler);
      },
    },
  };
});

import { INSTANCE_ID } from "./instance.js";
import { localHostInChannel, localTermOutChannel } from "./local-bus.js";
import {
  attachViewer,
  claimHost,
  daemonDisconnected,
  deliverScrollback,
  deliverToHost,
  enableLocalCluster,
  forwardDaemonReply,
  forwardOutput,
  forwardSize,
  hostHolderForTests,
  hostLeaseKey,
  isHostOnline,
  onForwardedDaemonReply,
  onOwnerTask,
  registerDaemon,
  resetRelayForTests,
  runOnOwner,
  runRelayHeartbeatForTests,
  sendToHost,
  type DaemonReply,
  type RelaySocket,
} from "./local-relay.js";

class FakeSocket implements RelaySocket {
  readyState = 1;
  sent: Array<string | Buffer> = [];
  closedWith: { code?: number; reason?: string } | null = null;
  pings = 0;
  send(data: string | Buffer) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closedWith = { code, reason };
  }
  ping() {
    this.pings++;
  }
  json(): Array<Record<string, unknown>> {
    return this.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d));
  }
  last(type: string): Record<string, unknown> {
    return this.json()
      .filter((m) => m.type === type)
      .at(-1)!;
  }
}

/** A message arriving from another instance on `channel`. */
function arrive(channel: string, header: Record<string, unknown>, payload?: Buffer): void {
  for (const h of listeners.get(channel) ?? []) {
    h({ channel, header, payload: payload ?? Buffer.alloc(0) });
  }
}
const sentOn = (channel: string, k?: string) =>
  published.filter((p) => p.channel === channel && (!k || p.header.k === k));

beforeEach(() => {
  resetRelayForTests();
  leases.clear();
  published.length = 0;
  listeners.clear();
  ctl.ask = "ok";
  ctl.seizeGate = null;
  ctl.attachGate = null;
  ctl.holderReads = 0;
  enableLocalCluster();
});
afterEach(() => resetRelayForTests());

async function ownHost(hostId: string) {
  const daemon = new FakeSocket();
  registerDaemon(hostId, null, daemon, { manageDirs: true });
  await claimHost(hostId, daemon);
  return { daemon, holder: leases.get(hostLeaseKey(hostId))! };
}

describe("the owner of a host", () => {
  it("claims the lease per connection, listens on the host's channel, and says so", async () => {
    const { holder } = await ownHost("h1");
    expect(holder.startsWith(`${INSTANCE_ID}#`)).toBe(true);
    expect(listeners.has(localHostInChannel("h1"))).toBe(true);
    expect(sentOn(localHostInChannel("h1"), "host-taken")).toHaveLength(1);
    expect(await isHostOnline("h1")).toBe(true);
  });

  it("serves a viewer on another instance: attach, snapshot, output, size, input, resize", async () => {
    const { daemon, holder } = await ownHost("h1");
    const hostIn = localHostInChannel("h1");
    const termOut = localTermOutChannel("t1");
    arrive(hostIn, { k: "attach", o: "inst-b", h: holder, t: "t1", v: "v1" });
    const attach = daemon.last("attach");
    expect(attach.terminalId).toBe("t1");

    // Output before the snapshot is not published (nobody enrolled yet).
    forwardOutput("h1", "t1", Buffer.from("early"));
    expect(sentOn(termOut, "out")).toHaveLength(0);

    deliverScrollback(String(attach.attachId), Buffer.from("history"), { cols: 90, rows: 30 });
    const sb = sentOn(termOut, "sb");
    expect(sb).toHaveLength(1);
    expect(sb[0].header).toMatchObject({ v: "v1", g: [90, 30] });
    expect(sb[0].payload?.toString()).toBe("history");

    forwardOutput("h1", "t1", Buffer.from("live"));
    forwardOutput("h1", "t1", Buffer.from("more"));
    expect(sentOn(termOut, "out").map((p) => p.payload?.toString())).toEqual(["live", "more"]);

    forwardSize("h1", "t1", 90, 30);
    const size = sentOn(termOut, "fr").find((p) => p.header.j === 1);
    expect(JSON.parse(size!.payload!.toString())).toMatchObject({ type: "size", cols: 90 });

    arrive(hostIn, { k: "input", o: "inst-b", h: holder, t: "t1", v: "v1" }, Buffer.from("ls\r"));
    const input = daemon.last("input");
    expect(Buffer.from(String(input.dataB64), "base64").toString()).toBe("ls\r");

    arrive(hostIn, { k: "claim", o: "inst-b", h: holder, t: "t1", v: "v1", g: [120, 40] });
    expect(daemon.last("resize")).toMatchObject({ cols: 120, rows: 40 });

    arrive(hostIn, { k: "detach", o: "inst-b", h: holder, t: "t1", v: "v1" });
    expect(daemon.last("detach")).toMatchObject({ terminalId: "t1" });
  });

  it("ignores frames meant for another connection of the host", async () => {
    const { daemon } = await ownHost("h1");
    const before = daemon.sent.length;
    arrive(localHostInChannel("h1"), { k: "attach", o: "b", h: "someone#else", t: "t1", v: "v1" });
    arrive(
      localHostInChannel("h1"),
      { k: "send", o: "b", h: "someone#else", rid: "r", rt: "b" },
      Buffer.from(JSON.stringify({ type: "kill", terminalId: "t1" })),
    );
    expect(daemon.sent.length).toBe(before);
  });

  it("forwards a request to the daemon, acknowledges it, and sends the answer back to the asker", async () => {
    const { daemon, holder } = await ownHost("h1");
    const request = { type: "dirs", requestId: "req-1", op: "add", path: "/x" };
    arrive(
      localHostInChannel("h1"),
      { k: "send", o: "inst-b", h: holder, rid: "rid-1", rt: "inst-b" },
      Buffer.from(JSON.stringify(request)),
    );
    expect(daemon.last("dirs")).toMatchObject({ requestId: "req-1" });
    expect(sentOn("reply:inst-b")[0].header).toMatchObject({ ok: true, rid: "rid-1" });

    // Another host can't answer it; the right one's answer goes to the asker.
    expect(forwardDaemonReply("h2", { type: "dirs-result", requestId: "req-1", dirs: [] })).toBe(
      false,
    );
    expect(forwardDaemonReply("h1", { type: "dirs-result", requestId: "req-1", dirs: [] })).toBe(
      true,
    );
    const relayed = sentOn("direct:inst-b", "daemon-reply");
    expect(relayed[0].header.h).toBe("h1");
    expect(JSON.parse(relayed[0].payload!.toString())).toMatchObject({ requestId: "req-1" });
    // Answered once: a repeat is this instance's own (nobody waits).
    expect(forwardDaemonReply("h1", { type: "dirs-result", requestId: "req-1", dirs: [] })).toBe(
      false,
    );
  });

  it("keeps relaying a transcript backfill until its last frame", async () => {
    const { holder } = await ownHost("h1");
    arrive(
      localHostInChannel("h1"),
      { k: "send", o: "inst-b", h: holder, rid: "r", rt: "inst-b" },
      Buffer.from(
        JSON.stringify({ type: "transcript-request", requestId: "bf", terminalId: "t1" }),
      ),
    );
    const frame = (done: boolean) =>
      ({
        type: "transcript-backfill",
        requestId: "bf",
        terminalId: "t1",
        entries: [],
        done,
      }) as never;
    expect(forwardDaemonReply("h1", frame(false))).toBe(true);
    expect(forwardDaemonReply("h1", frame(true))).toBe(true);
    expect(forwardDaemonReply("h1", frame(true))).toBe(false);
  });

  it("gives the host up when another connection seized it, without going offline", async () => {
    const { daemon } = await ownHost("h1");
    leases.set(hostLeaseKey("h1"), "inst-b:1#newer");
    arrive(localHostInChannel("h1"), { k: "host-taken", o: "inst-b:1" });
    await vi.waitFor(() => expect(daemon.closedWith?.code).toBe(4000));
    // Its close is not the host going offline: the newer connection has it.
    expect(await daemonDisconnected("h1", daemon)).toBe(false);
    expect(listeners.has(localHostInChannel("h1"))).toBe(false);
  });

  it("keeps the host when the host-taken it hears is stale (it seized last)", async () => {
    const { daemon } = await ownHost("h1");
    arrive(localHostInChannel("h1"), { k: "host-taken", o: "inst-b:1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(daemon.closedWith).toBeNull();
  });

  it("releases its own lease when its daemon disconnects", async () => {
    const { daemon } = await ownHost("h1");
    expect(await daemonDisconnected("h1", daemon)).toBe(true);
    expect(leases.has(hostLeaseKey("h1"))).toBe(false);
    expect(await isHostOnline("h1")).toBe(false);
  });

  it("asks viewers it never heard of to reconnect, and drops ones no longer reported", async () => {
    const { daemon, holder } = await ownHost("h1");
    const hostIn = localHostInChannel("h1");
    arrive(hostIn, { k: "attach", o: "inst-b", h: holder, t: "t1", v: "v1" });
    arrive(hostIn, { k: "viewers", o: "inst-b", h: holder, vs: [["t1", "v-unknown"]] });
    const close = sentOn(localTermOutChannel("t1"), "close");
    expect(close).toHaveLength(1);
    expect(close[0].header).toMatchObject({ v: "v-unknown", c: 4503 });
    // v1 wasn't listed: dropped, and with no viewer left the daemon stops streaming.
    expect(daemon.last("detach")).toMatchObject({ terminalId: "t1" });
  });
});

describe("a viewer of a daemon owned elsewhere", () => {
  const OWNER = "inst-a:1";
  const HOLDER = `${OWNER}#conn1`;

  it("attaches through the owner and takes only the owner's frames", async () => {
    leases.set(hostLeaseKey("h9"), HOLDER);
    const viewer = new FakeSocket();
    const handle = await attachViewer("h9", "t9", viewer);
    expect(handle).not.toBeNull();
    const hostIn = localHostInChannel("h9");
    const termOut = localTermOutChannel("t9");
    const attach = sentOn(hostIn, "attach")[0];
    expect(attach.header).toMatchObject({ h: HOLDER, t: "t9" });
    const v = String(attach.header.v);

    // Output before the snapshot is not this viewer's yet.
    arrive(termOut, { k: "out", o: OWNER }, Buffer.from("early"));
    arrive(termOut, { k: "sb", o: OWNER, v, g: [80, 24] }, Buffer.from("snap"));
    arrive(termOut, { k: "out", o: OWNER }, Buffer.from("live"));
    // A previous owner still talking is ignored.
    arrive(termOut, { k: "out", o: "inst-old:1" }, Buffer.from("stale"));
    arrive(
      termOut,
      { k: "fr", o: OWNER, v, j: 1 },
      Buffer.from(JSON.stringify({ type: "size", cols: 80, rows: 24, yours: true })),
    );
    arrive(
      termOut,
      { k: "notify", o: "inst-c:1", p: 1 },
      Buffer.from(JSON.stringify({ type: "status", state: "running" })),
    );
    const frames = viewer.sent.map((d) =>
      typeof d === "string" ? JSON.parse(d).type : d.toString(),
    );
    expect(frames).toEqual(["replay", "snap", "live", "size", "status"]);

    handle!.input("hi");
    handle!.claim({ cols: 100, rows: 30 });
    handle!.view({ cols: 100, rows: 30, visible: true, idleMs: 0, open: true });
    handle!.pong();
    expect(sentOn(hostIn).map((p) => p.header.k)).toEqual([
      "attach",
      "input",
      "claim",
      "view",
      "pong",
    ]);
    expect(sentOn(hostIn, "input")[0].payload?.toString()).toBe("hi");
    expect(sentOn(hostIn).every((p) => p.header.h === HOLDER && p.header.v === v)).toBe(true);

    handle!.detach();
    expect(sentOn(hostIn, "detach")).toHaveLength(1);
    expect(listeners.has(termOut)).toBe(false);
  });

  it("reports its viewers to the owner and reconnects them when the host changes hands", async () => {
    leases.set(hostLeaseKey("h9"), HOLDER);
    const viewer = new FakeSocket();
    await attachViewer("h9", "t9", viewer);
    await runRelayHeartbeatForTests();
    const report = sentOn(localHostInChannel("h9"), "viewers");
    expect(report).toHaveLength(1);
    expect(report[0].header.h).toBe(HOLDER);

    leases.set(hostLeaseKey("h9"), "inst-b:1#conn2");
    await runRelayHeartbeatForTests();
    expect(viewer.closedWith?.code).toBe(4503);
  });

  it("is offline when nobody holds the host, and becomes this instance's when the daemon connects here", async () => {
    expect(await attachViewer("h9", "t9", new FakeSocket())).toBeNull();
    expect(await sendToHost("h9", { type: "pong" })).toBe(false);

    leases.set(hostLeaseKey("h9"), HOLDER);
    const remote = new FakeSocket();
    await attachViewer("h9", "t9", remote);
    // The daemon reconnects to this instance: viewers streaming through the
    // old owner reconnect to the new connection.
    const daemon = new FakeSocket();
    registerDaemon("h9", null, daemon);
    expect(remote.closedWith?.code).toBe(4503);
    const here = new FakeSocket();
    await attachViewer("h9", "t9", here);
    expect(daemon.last("attach")).toMatchObject({ terminalId: "t9" });
  });

  it("sends to a daemon owned elsewhere with an acknowledged request naming the holder", async () => {
    leases.set(hostLeaseKey("h9"), HOLDER);
    expect(await sendToHost("h9", { type: "kill", terminalId: "t9" })).toBe(true);
    const req = sentOn(localHostInChannel("h9"), "send")[0];
    expect(req.header.h).toBe(HOLDER);
    expect(JSON.parse(req.payload!.toString())).toMatchObject({ type: "kill" });
  });
});

/** A promise and the function that settles it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("review fixes", () => {
  it("(2) says unacknowledged — not offline — when the owner heard a frame but didn't ack it", async () => {
    leases.set(hostLeaseKey("h9"), "inst-a:1#c1");
    ctl.ask = "timeout";
    expect(await deliverToHost("h9", { type: "kill", terminalId: "t9" })).toBe("unacknowledged");
    // It may have reached the daemon: callers treat it as sent.
    expect(await sendToHost("h9", { type: "kill", terminalId: "t9" })).toBe(true);
    ctl.ask = "unheard";
    expect(await deliverToHost("h9", { type: "kill", terminalId: "t9" })).toBe("offline");
    ctl.ask = "ok";
    expect(await deliverToHost("h9", { type: "kill", terminalId: "t9" })).toBe("sent");
  });

  it("(3, 4) a host-taken heard before the claim completes is re-read after it: the lease is ours, we stay", async () => {
    const seize = gate();
    ctl.seizeGate = seize.promise;
    const daemon = new FakeSocket();
    registerDaemon("h1", null, daemon);
    const claiming = claimHost("h1", daemon);
    await tick();
    // A rival seized first and said so while we were still claiming.
    leases.set(hostLeaseKey("h1"), "inst-b:1#rival");
    arrive(localHostInChannel("h1"), { k: "host-taken", o: "inst-b:1" });
    await tick();
    expect(daemon.closedWith).toBeNull();
    // Our seize lands last: the lease is ours.
    seize.open();
    await claiming;
    expect(leases.get(hostLeaseKey("h1"))).toBe(hostHolderForTests("h1"));
    await tick();
    expect(daemon.closedWith).toBeNull();
  });

  it("(4) a frame naming this connection that arrives before its claim lands is handled right after it", async () => {
    const seize = gate();
    ctl.seizeGate = seize.promise;
    const daemon = new FakeSocket();
    registerDaemon("h1", null, daemon);
    const claiming = claimHost("h1", daemon);
    await tick();
    const holder = hostHolderForTests("h1")!;
    arrive(
      localHostInChannel("h1"),
      { k: "send", o: "inst-b:1", h: holder, rid: "r", rt: "inst-b:1" },
      Buffer.from(JSON.stringify({ type: "kill", terminalId: "t1" })),
    );
    // Not before the claim...
    expect(daemon.json().some((m) => m.type === "kill")).toBe(false);
    seize.open();
    await claiming;
    // ...and right after it, acknowledged.
    expect(daemon.last("kill")).toMatchObject({ terminalId: "t1" });
    expect(sentOn("reply:inst-b:1")[0].header).toMatchObject({ ok: true, rid: "r" });
    // A frame naming some other connection is never this one's.
    arrive(
      localHostInChannel("h1"),
      { k: "send", o: "inst-b:1", h: "inst-c:1#other", rid: "r2", rt: "inst-b:1" },
      Buffer.from(JSON.stringify({ type: "kill", terminalId: "t2" })),
    );
    expect(daemon.json().some((m) => m.terminalId === "t2")).toBe(false);
  });

  it("(3) a connection that lost the lease gives up on host-taken; one that holds it never does", async () => {
    const { daemon } = await ownHost("h1");
    // host-taken while the lease is still ours: a re-read, nothing more.
    arrive(localHostInChannel("h1"), { k: "host-taken", o: "inst-b:1" });
    await tick();
    expect(daemon.closedWith).toBeNull();
    leases.set(hostLeaseKey("h1"), "inst-b:1#newer");
    arrive(localHostInChannel("h1"), { k: "host-taken", o: "inst-b:1" });
    await vi.waitFor(() => expect(daemon.closedWith?.code).toBe(4000));
  });

  it("(5) relayed daemon answers are delivered in order per host, even when one is slow", async () => {
    const order: string[] = [];
    const first = gate();
    onForwardedDaemonReply(async (_hostId, msg: DaemonReply) => {
      const id = (msg as { requestId: string; done?: boolean }).requestId;
      if ((msg as { entries?: unknown[] }).entries?.length === 1) await first.promise;
      order.push(`${id}:${(msg as { done?: boolean }).done ? "done" : "part"}`);
    });
    const relayed = (msg: Record<string, unknown>) =>
      direct.get("daemon-reply")!({
        channel: "",
        header: { k: "daemon-reply", o: "inst-a:1", h: "h1" },
        payload: Buffer.from(JSON.stringify(msg)),
      });
    relayed({ type: "transcript-backfill", requestId: "bf", terminalId: "t", entries: [1] });
    relayed({
      type: "transcript-backfill",
      requestId: "bf",
      terminalId: "t",
      entries: [],
      done: true,
    });
    await tick();
    expect(order).toEqual([]);
    first.open();
    await vi.waitFor(() => expect(order).toEqual(["bf:part", "bf:done"]));
  });

  it("(7) a viewer whose attach is still going out isn't reported to the owner", async () => {
    leases.set(hostLeaseKey("h9"), "inst-a:1#c1");
    const attachOut = gate();
    ctl.attachGate = attachOut.promise;
    const pending = attachViewer("h9", "t9", new FakeSocket());
    await tick();
    await runRelayHeartbeatForTests();
    expect(sentOn(localHostInChannel("h9"), "viewers")).toHaveLength(0);
    attachOut.open();
    expect(await pending).not.toBeNull();
    await runRelayHeartbeatForTests();
    expect(sentOn(localHostInChannel("h9"), "viewers")).toHaveLength(1);
  });

  it("(8) never relays a credentials answer, and never asks for credentials for another instance", async () => {
    const { daemon, holder } = await ownHost("h1");
    const before = daemon.sent.length;
    arrive(
      localHostInChannel("h1"),
      { k: "send", o: "inst-b:1", h: holder, rid: "r1", rt: "inst-b:1" },
      Buffer.from(JSON.stringify({ type: "credentials", requestId: "cr" })),
    );
    expect(daemon.sent.length).toBe(before);
    expect(sentOn("reply:inst-b:1")).toHaveLength(0);
    expect(
      forwardDaemonReply("h1", {
        type: "credentials-result",
        requestId: "cr",
        token: "sk-ant-oat01-secret",
      }),
    ).toBe(false);
    expect(published.some((p) => p.payload?.toString().includes("sk-ant"))).toBe(false);
  });

  it("(8) runs owner work where the daemon is and returns only its result", async () => {
    onOwnerTask("echo-task", async (hostId, args) => ({ hostId, got: args.n }));
    const { holder } = await ownHost("h1");
    // Here: run directly.
    expect(await runOnOwner("h1", "echo-task", { n: 1 }, 1_000)).toEqual({
      result: { hostId: "h1", got: 1 },
    });
    // Asked from another instance: the reply carries the result.
    arrive(
      localHostInChannel("h1"),
      { k: "task", o: "inst-b:1", h: holder, task: "echo-task", rid: "t1", rt: "inst-b:1" },
      Buffer.from(JSON.stringify({ n: 2 })),
    );
    await vi.waitFor(() => expect(sentOn("reply:inst-b:1")).toHaveLength(1));
    const reply = sentOn("reply:inst-b:1")[0];
    expect(JSON.parse(reply.payload!.toString())).toEqual({ hostId: "h1", got: 2 });
    // Elsewhere: through the owner.
    leases.set(hostLeaseKey("h9"), "inst-a:1#c1");
    expect(await runOnOwner("h9", "echo-task", { n: 3 }, 1_000)).toEqual({
      result: { ran: "echo-task" },
    });
  });

  it("(10) one heartbeat at a time, with one lease read for every host", async () => {
    leases.set(hostLeaseKey("h7"), "inst-a:1#c1");
    leases.set(hostLeaseKey("h8"), "inst-b:1#c2");
    await attachViewer("h7", "t7", new FakeSocket());
    await attachViewer("h8", "t8", new FakeSocket());
    ctl.holderReads = 0;
    await Promise.all([runRelayHeartbeatForTests(), runRelayHeartbeatForTests()]);
    expect(ctl.holderReads).toBe(1);
    expect(sentOn(localHostInChannel("h7"), "viewers")).toHaveLength(1);
    expect(sentOn(localHostInChannel("h8"), "viewers")).toHaveLength(1);
  });
});
