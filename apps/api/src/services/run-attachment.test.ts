/**
 * The one attach loop (run-attachment.ts): byte-exact offsets, replay from
 * byte 0 feeding the derivations without storing anything, the lease's
 * renew-or-lose, shutdown's detach (and its wait for runs past their
 * stream), the rule that stops an agent its job left behind, and the
 * run-directory housekeeping.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import type { ContainerRuntime, RunAttachment, RunExit } from "@optio/container-runtime";

const mockAppend = vi.fn();
const mockUpdateReturning = vi.fn();
const mockUpdateSet = vi.fn();
const mockSelectRows = vi.fn();

vi.mock("../db/client.js", () => {
  const chain = {
    set: (values: unknown) => {
      mockUpdateSet(values);
      return chain;
    },
    where: () => chain,
    returning: () => mockUpdateReturning(),
  };
  const select = () => ({ from: () => ({ where: () => mockSelectRows() }) });
  return { db: { update: () => chain, select } };
});

vi.mock("./run-log-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./run-log-service.js")>();
  return { ...actual, appendRunLogsBatch: (...args: unknown[]) => mockAppend(...args) };
});

const mockGetPod = vi.fn();
const mockKillRun = vi.fn();
vi.mock("./agent-pod-pool.js", () => ({
  getPod: (...args: unknown[]) => mockGetPod(...args),
  podHandle: (pod: { podId: string | null; podName: string }) => ({
    id: pod.podId ?? pod.podName,
    name: pod.podName,
  }),
}));
vi.mock("./container-service.js", () => ({
  getRuntime: () => ({ killRun: (...args: unknown[]) => mockKillRun(...args) }),
}));
const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../logger.js", () => ({ logger: { ...mockLog, child: () => mockLog } }));

import {
  AttachmentLostError,
  LineSplitter,
  agentLeftBehind,
  detachAll,
  endRunJob,
  heldRunCount,
  onStreamError,
  holdsRun,
  isRemovableRunDir,
  removeRunDirectory,
  runAttachJob,
  signalRun,
  startHold,
  streamRun,
  withStderr,
  type ParsedRunLine,
  ATTACH_RENEW_MS,
} from "./run-attachment.js";

const ref = { kind: "work-run" as const, id: "run-1" };

/** A runtime whose attach plays `chunks` from byte 0 and then exits. */
function fakeRuntime(chunks: Buffer[], exit: RunExit = { kind: "exited", code: 0 }) {
  const delivered: string[] = [];
  let closed = false;
  const runtime = {
    attachRun: vi.fn(async (): Promise<RunAttachment> => {
      const output = Readable.from(chunks);
      let finished: () => void = () => {};
      const ended = new Promise<void>((r) => {
        finished = r;
        output.on("end", r);
        output.on("close", r);
      });
      return {
        output,
        exit: ended.then(() => (closed ? { kind: "detached", reason: "closed" } : exit)),
        close() {
          closed = true;
          output.destroy();
          finished();
        },
      };
    }),
    deliverStdin: vi.fn(async (_h: unknown, input: { line: string }) => {
      delivered.push(input.line);
    }),
  } as unknown as ContainerRuntime;
  return { runtime, delivered };
}

/** Lines as the fake agent writes them (JSON events with a seq). */
function lines(...events: Array<Record<string, unknown>>): Buffer {
  return Buffer.from(events.map((e) => JSON.stringify(e) + "\n").join(""), "utf8");
}

const parse = (line: string): ParsedRunLine => {
  const event = JSON.parse(line) as { text?: string; session?: string; terminal?: boolean };
  return {
    entries: event.text ? [{ type: "text", content: event.text } as never] : [],
    sessionId: event.session,
    isTerminal: event.terminal,
  };
};

function hold() {
  return {
    ref,
    token: "me/1",
    agent: { podId: "pod-1", pid: 77 },
    phase: "setup",
    lost: false,
    released: false,
    attachment: null,
    end: vi.fn(),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAppend.mockImplementation(async (_ref, entries: unknown[]) =>
    entries.map((e, i) => ({ id: `row-${i}`, ...(e as object) })),
  );
});

describe("LineSplitter", () => {
  it("counts offsets in bytes, multi-byte characters included", () => {
    const text = "héllo 🎉\nwörld\n";
    const splitter = new LineSplitter(0);
    const out = splitter.push(Buffer.from(text, "utf8"));
    expect(out).toEqual([
      { text: "héllo 🎉", end: Buffer.byteLength("héllo 🎉\n") },
      { text: "wörld", end: Buffer.byteLength(text) },
    ]);
    expect(out[1].end).toBeGreaterThan(text.length);
  });

  it("holds a partial line — and a character split across chunks — until its newline", () => {
    const bytes = Buffer.from("ab🎉cd\nnext\n", "utf8");
    const splitter = new LineSplitter(0);
    // Split inside the 4-byte emoji, and again before the newline.
    expect(splitter.push(bytes.subarray(0, 4))).toEqual([]);
    expect(splitter.push(bytes.subarray(4, 7))).toEqual([]);
    const out = splitter.push(bytes.subarray(7));
    expect(out).toEqual([
      { text: "ab🎉cd", end: Buffer.byteLength("ab🎉cd\n") },
      { text: "next", end: bytes.length },
    ]);
  });

  it("flushes an unterminated last line at the file's end", () => {
    const splitter = new LineSplitter(0);
    splitter.push(Buffer.from("one\ntwo", "utf8"));
    expect(splitter.flush()).toEqual({ text: "two", end: 7 });
    expect(splitter.flush()).toBeNull();
  });
});

describe("streamRun", () => {
  it("stores every new line with byte-exact offsets, one batch per chunk", async () => {
    const a = lines({ seq: 1, text: "héllo" }, { seq: 2, text: "🎉 done" });
    const b = lines({ seq: 3, text: "wörld" });
    const { runtime } = fakeRuntime([a, b]);
    const published: unknown[] = [];

    const result = await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: hold(),
      consumedBytes: 0,
      parse,
      publish: async (row) => void published.push(row),
    });

    expect(result.outcome).toEqual({ kind: "exited", code: 0 });
    expect(result.consumedBytes).toBe(a.length + b.length);
    expect(mockAppend).toHaveBeenCalledTimes(2);
    expect(mockAppend.mock.calls[0][2]).toEqual({ from: 0, to: a.length });
    expect(mockAppend.mock.calls[1][2]).toEqual({ from: a.length, to: a.length + b.length });
    expect(mockAppend.mock.calls[0][1].map((e: { content: string }) => e.content)).toEqual([
      "héllo",
      "🎉 done",
    ]);
    expect(published).toHaveLength(3);
  });

  it("a line with a NUL in it is stored like any other and the run finishes", async () => {
    // The store (run-log-service) turns the NUL into U+FFFD before the
    // insert; the loop itself neither chokes on it nor counts an attach
    // failure, so the run ends with the agent's exit.
    const a = lines({ seq: 1, text: "bin\u0000ary" }, { seq: 2, text: "done" });
    const { runtime } = fakeRuntime([a]);

    const result = await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: hold(),
      consumedBytes: 0,
      parse,
      publish: async () => {},
    });

    expect(result.outcome).toEqual({ kind: "exited", code: 0 });
    expect(result.consumedBytes).toBe(a.length);
    expect(mockAppend).toHaveBeenCalledTimes(1);
    expect(mockAppend.mock.calls[0][1].map((e: { content: string }) => e.content)).toEqual([
      "bin\u0000ary",
      "done",
    ]);
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it("a partial line across chunks is stored once, when complete", async () => {
    const all = lines({ seq: 1, text: "ä".repeat(5) }, { seq: 2, text: "end" });
    const cut = 9; // inside the first line, between the bytes of an "ä"
    const { runtime } = fakeRuntime([all.subarray(0, cut), all.subarray(cut)]);
    await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: hold(),
      consumedBytes: 0,
      parse,
      publish: async () => {},
    });
    const batches = mockAppend.mock.calls.map((c) => c[2]);
    expect(batches).toEqual([{ from: 0, to: all.length }]);
    expect(mockAppend.mock.calls[0][1].map((e: { content: string }) => e.content)).toEqual([
      "ä".repeat(5),
      "end",
    ]);
  });

  it("replays from byte 0: lines below the offset feed the derivations and are never stored", async () => {
    const before = lines({ seq: 1, session: "sess-1", text: "first" }, { seq: 2, text: "second" });
    const after = lines({ seq: 3, text: "third", terminal: true });
    const { runtime, delivered } = fakeRuntime([Buffer.concat([before, after])]);
    const derived: string[] = [];
    const onSession = vi.fn();

    const result = await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: hold(),
      consumedBytes: before.length,
      parse,
      derive: (line) => void derived.push(line),
      onSession,
      publish: async () => {},
    });

    // Every line reached the derivations, the replayed ones too…
    expect(derived.map((l) => JSON.parse(l).seq)).toEqual([1, 2, 3]);
    // …the session id is known again, but nothing replayed is persisted.
    expect(result.sessionId).toBe("sess-1");
    expect(onSession).not.toHaveBeenCalled();
    expect(mockAppend).toHaveBeenCalledTimes(1);
    expect(mockAppend.mock.calls[0][1].map((e: { content: string }) => e.content)).toEqual([
      "third",
    ]);
    expect(mockAppend.mock.calls[0][2]).toEqual({
      from: before.length,
      to: before.length + after.length,
    });
    // The terminal event closed the agent's stdin.
    expect(delivered).toEqual(["__OPTIO_STDIN_EOF__"]);
  });

  it("a terminal event seen only in the replay still closes stdin (the last holder may have died first)", async () => {
    const all = lines({ seq: 1, text: "x", terminal: true });
    const { runtime, delivered } = fakeRuntime([all]);
    await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: hold(),
      consumedBytes: all.length,
      parse,
      publish: async () => {},
    });
    expect(delivered).toEqual(["__OPTIO_STDIN_EOF__"]);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("a new session id is persisted once, from a new line", async () => {
    const { runtime } = fakeRuntime([
      lines({ seq: 1, session: "s-9" }, { seq: 2, session: "s-9", text: "again" }),
    ]);
    const onSession = vi.fn();
    await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: hold(),
      consumedBytes: 0,
      parse,
      onSession,
      publish: async () => {},
    });
    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession).toHaveBeenCalledWith("s-9");
  });

  it("stores an unterminated last line when the agent exits", async () => {
    const head = lines({ seq: 1, text: "a" });
    const tail = Buffer.from(JSON.stringify({ seq: 2, text: "tail" }), "utf8");
    const { runtime } = fakeRuntime([head, tail]);
    const result = await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: hold(),
      consumedBytes: 0,
      parse,
      publish: async () => {},
    });
    expect(result.consumedBytes).toBe(head.length + tail.length);
    expect(mockAppend.mock.calls.at(-1)![2]).toEqual({
      from: head.length,
      to: head.length + tail.length,
    });
  });

  it("a commit that finds the run taken ends the stream as taken, storing nothing more", async () => {
    mockAppend.mockRejectedValueOnce(new AttachmentLostError("run-1"));
    // Another hold has the same attempt (the same agent).
    mockSelectRows.mockResolvedValueOnce([{ execState: "started", execPid: 77 }]);
    const { runtime } = fakeRuntime([lines({ seq: 1, text: "a" }), lines({ seq: 2, text: "b" })]);
    const h = hold();
    const result = await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: h,
      consumedBytes: 0,
      parse,
      publish: async () => {},
    });
    expect(result.outcome).toEqual({ kind: "taken" });
    expect(result.consumedBytes).toBe(0);
    expect(mockAppend).toHaveBeenCalledTimes(1);
    // The batch was a CAS on this hold's own mark.
    expect(mockAppend.mock.calls[0][3]).toBe("me/1");
  });

  it("a commit that finds the attempt reset (queued again) ends the stream as reset, not taken", async () => {
    mockAppend.mockRejectedValueOnce(new AttachmentLostError("run-1"));
    mockSelectRows.mockResolvedValueOnce([{ execState: null, execPid: null }]);
    const { runtime } = fakeRuntime([lines({ seq: 1, text: "a" })]);
    const result = await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: hold(),
      consumedBytes: 0,
      parse,
      publish: async () => {},
    });
    expect(result.outcome).toEqual({ kind: "reset" });

    // A new attempt already started (another supervisor): reset too.
    mockAppend.mockRejectedValueOnce(new AttachmentLostError("run-1"));
    mockSelectRows.mockResolvedValueOnce([{ execState: "started", execPid: 99 }]);
    const again = await streamRun({
      runtime: fakeRuntime([lines({ seq: 1, text: "a" })]).runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: hold(),
      consumedBytes: 0,
      parse,
      publish: async () => {},
    });
    expect(again.outcome).toEqual({ kind: "reset" });
  });

  it("a run past its stream is settling: shutdown waits for it instead of letting it go", async () => {
    const h = hold() as { phase: string };
    const { runtime } = fakeRuntime([lines({ seq: 1, text: "a" })]);
    await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: h as never,
      consumedBytes: 0,
      parse,
      publish: async () => {},
    });
    expect(h.phase).toBe("settling");
  });

  it("a stdin already closed (a replayed turn end) is not an error", async () => {
    const { RunStdinClosedError } = await import("@optio/container-runtime");
    const all = lines({ seq: 1, text: "x", terminal: true });
    const { runtime } = fakeRuntime([all]);
    (runtime.deliverStdin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new RunStdinClosedError("/home/agent/optio/runs/run-1"),
    );
    mockLog.warn.mockClear();
    const result = await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: hold(),
      consumedBytes: all.length,
      parse,
      publish: async () => {},
    });
    expect(result.outcome).toEqual({ kind: "exited", code: 0 });
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it("a detached exit (the exec dropped) is reported as such", async () => {
    const { runtime } = fakeRuntime([lines({ seq: 1, text: "a" })], {
      kind: "detached",
      reason: "stream-ended",
    });
    const result = await streamRun({
      runtime,
      handle: { id: "pod", name: "pod" },
      ref,
      runDir: "/home/agent/optio/runs/run-1",
      hold: hold(),
      consumedBytes: 0,
      parse,
      publish: async () => {},
    });
    expect(result.outcome).toEqual({ kind: "detached", reason: "stream-ended" });
  });
});

describe("runAttachJob", () => {
  // Before the shutdown tests below: after `detachAll` every attach job skips.
  it("does nothing when a job of this process already holds the run", async () => {
    mockUpdateReturning.mockResolvedValue([{ id: "x" }]);
    const h = startHold(ref, "me/1");
    const finish = vi.fn();
    const writes = mockUpdateSet.mock.calls.length;
    const ended = await runAttachJob({
      ref,
      log: mockLog as never,
      podId: "pod-1",
      onPodGone: vi.fn(),
      onAttachFailed: vi.fn(),
      finish,
    });
    expect(ended).toBe("skipped");
    expect(finish).not.toHaveBeenCalled();
    // Not even a claim was tried.
    expect(mockUpdateSet.mock.calls.length).toBe(writes);
    await h.end();
  });

  function attachSpec(finish: () => Promise<never>) {
    return {
      ref: { kind: "work-run" as const, id: "flaky" },
      log: mockLog as never,
      podId: "pod-1",
      onPodGone: vi.fn(),
      onAttachFailed: vi.fn(async () => {}),
      afterFinish: vi.fn(async () => {}),
      finish: vi.fn(finish),
    };
  }

  it("a finish that throws while streaming leaves the run for the next attach: no kill, lease given up, slot kept", async () => {
    mockGetPod.mockResolvedValue({ id: "pod-1", podId: "p1", podName: "pod-1", state: "ready" });
    mockUpdateReturning
      .mockResolvedValueOnce([{ consumedBytes: 10, execState: "started", pid: 7 }]) // the claim
      .mockResolvedValueOnce([{ failures: 1 }]); // the attempt's first failed attach
    mockUpdateSet.mockClear();
    const spec = attachSpec(async () => {
      throw new Error("db blip");
    });
    await expect(runAttachJob(spec)).rejects.toThrow("db blip");
    expect(spec.onAttachFailed).not.toHaveBeenCalled();
    expect(mockKillRun).not.toHaveBeenCalled();
    expect(spec.afterFinish).not.toHaveBeenCalled();
    const releases = mockUpdateSet.mock.calls
      .map((c) => c[0] as { attachLeaseUntil?: Date })
      .filter((v) => v.attachLeaseUntil && v.attachLeaseUntil.getTime() <= Date.now());
    expect(releases).toHaveLength(1);
    expect(heldRunCount()).toBe(0);
    mockGetPod.mockReset();
  });

  it("the attempt's third failed attach in a row fails the run and stops its agent", async () => {
    mockGetPod.mockResolvedValue({ id: "pod-1", podId: "p1", podName: "pod-1", state: "ready" });
    mockUpdateReturning
      .mockResolvedValueOnce([{ consumedBytes: 10, execState: "started", pid: 7 }])
      .mockResolvedValueOnce([{ failures: 3 }]);
    // Still running, nobody else streaming it (its lease just given up): left behind.
    mockSelectRows.mockResolvedValueOnce([
      { execState: "started", execPid: 7, attachedBy: "gone/1", attachLeaseUntil: null },
    ]);
    mockKillRun.mockResolvedValueOnce(true);
    const spec = attachSpec(async () => {
      throw new Error("parser exploded");
    });
    await expect(runAttachJob(spec)).rejects.toThrow("parser exploded");
    expect(spec.onAttachFailed).toHaveBeenCalledWith(
      "Attaching to the run failed 3 times in a row; last error: parser exploded",
    );
    expect(mockKillRun).toHaveBeenCalledWith(
      { id: "p1", name: "pod-1" },
      expect.objectContaining({ runId: "flaky", signal: "TERM", pid: 7 }),
    );
    expect(spec.afterFinish).toHaveBeenCalled();
    mockGetPod.mockReset();
  });
});

describe("the hold: renew or lose", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renews every ATTACH_RENEW_MS while the run is still this hold's", async () => {
    mockUpdateReturning.mockResolvedValue([{ id: "run-1" }]);
    const h = startHold(ref, "me/1");
    await vi.advanceTimersByTimeAsync(ATTACH_RENEW_MS * 3);
    expect(mockUpdateReturning).toHaveBeenCalledTimes(3);
    expect(h.lost).toBe(false);
    await h.end();
  });

  it("a renewal that matches nothing means the run was taken: the stream is severed at once", async () => {
    mockUpdateReturning.mockResolvedValue([]);
    const h = startHold(ref, "me/1");
    const close = vi.fn();
    h.attachment = { close };
    await vi.advanceTimersByTimeAsync(ATTACH_RENEW_MS);
    expect(h.lost).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    // A lost hold gives nothing back: the lease is someone else's.
    const writes = mockUpdateSet.mock.calls.length;
    await h.end({ release: true });
    expect(mockUpdateSet.mock.calls.length).toBe(writes);
  });

  it("knows which runs a job of this process holds", async () => {
    mockUpdateReturning.mockResolvedValue([{ id: "run-1" }]);
    const h = startHold(ref, "me/1");
    expect(holdsRun(ref)).toBe(true);
    expect(holdsRun({ kind: "turn", id: "run-1" })).toBe(false);
    await h.end();
    expect(holdsRun(ref)).toBe(false);
  });

  it("shutdown severs every stream and gives its lease up now; runs past their stream settle first", async () => {
    mockUpdateReturning.mockResolvedValue([{ id: "x" }]);
    const a = startHold({ kind: "work-run", id: "a" }, "me/a", { phase: "streaming" });
    const b = startHold({ kind: "turn", id: "b" }, "me/b");
    const settling = startHold({ kind: "review-run", id: "c" }, "me/c", { phase: "settling" });
    const closeA = vi.fn();
    const closeB = vi.fn();
    const closeC = vi.fn();
    a.attachment = { close: closeA };
    b.attachment = { close: closeB };
    settling.attachment = { close: closeC };
    const before = Date.now();

    expect(heldRunCount()).toBe(3);
    const detaching = detachAll({ settleWaitMs: 10_000 });
    // The settling run finishes a moment later, its lease its own the while.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(heldRunCount()).toBe(1);
    await settling.end();
    expect(await detaching).toEqual({ detached: 2, settled: 1 });

    expect(closeA).toHaveBeenCalled();
    expect(closeB).toHaveBeenCalled();
    expect(closeC).not.toHaveBeenCalled();
    expect(a.released && b.released).toBe(true);
    expect(settling.released).toBe(false);
    expect(heldRunCount()).toBe(0);
    const releases = mockUpdateSet.mock.calls
      .map((c) => c[0] as { attachLeaseUntil?: Date })
      .filter((v) => v.attachLeaseUntil && v.attachLeaseUntil.getTime() <= before);
    expect(releases).toHaveLength(2);
  });

  it("shutdown waits for a settling run only so long", async () => {
    mockUpdateReturning.mockResolvedValue([{ id: "x" }]);
    const slow = startHold({ kind: "work-run", id: "slow" }, "me/s", { phase: "settling" });
    const detaching = detachAll({ settleWaitMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await detaching).toEqual({ detached: 0, settled: 1 });
    // Still its job's: renewing, its lease not given up.
    expect(heldRunCount()).toBe(1);
    expect(slow.released).toBe(false);
    await slow.end();
  });
});

describe("signalRun: any instance stops a run", () => {
  it("finds the pod from the database and signals the run directory named by the run", async () => {
    mockGetPod.mockResolvedValueOnce({ id: "pod-9", podId: "p9", podName: "pod-9" });
    mockKillRun.mockResolvedValueOnce(true);
    expect(await signalRun("pod-9", "run-1", "TERM")).toBe(true);
    expect(mockGetPod).toHaveBeenCalledWith("pod-9");
    expect(mockKillRun).toHaveBeenCalledWith(
      { id: "p9", name: "pod-9" },
      { runId: "run-1", runDir: "/home/agent/optio/runs/run-1", signal: "TERM" },
    );
  });

  it("is a no-op without a pod, and never throws", async () => {
    expect(await signalRun(null, "run-1")).toBe(false);
    mockGetPod.mockResolvedValueOnce(null);
    expect(await signalRun("gone", "run-1")).toBe(false);
    mockGetPod.mockResolvedValueOnce({ id: "pod-9", podId: "p9", podName: "pod-9" });
    mockKillRun.mockRejectedValueOnce(new Error("exec failed"));
    expect(await signalRun("pod-9", "run-1", "KILL")).toBe(false);
  });
});

describe("endRunJob: the agent a job leaves behind is stopped", () => {
  const agent = { podId: "pod-1", pid: 77 };
  const future = () => new Date(Date.now() + 60_000);
  const past = () => new Date(Date.now() - 1_000);
  const me = { token: "me/1", agent };

  it("decides from the run row: stopped unless its exit is recorded or another hold streams it", () => {
    const row = (r: Partial<Parameters<typeof agentLeftBehind>[1] & object>) => ({
      execState: "started",
      execPid: 77,
      attachedBy: "me/1",
      attachLeaseUntil: future(),
      ...r,
    });
    // An error halfway: still this hold's, still running — left behind.
    expect(agentLeftBehind(me, row({}))).toBe(true);
    // Settled by someone: it exited.
    expect(agentLeftBehind(me, row({ execState: "exited" }))).toBe(false);
    // Another hold streams the same agent under a live lease: its, not left behind.
    expect(agentLeftBehind(me, row({ attachedBy: "other/2" }))).toBe(false);
    // …but not once that lease lapsed.
    expect(agentLeftBehind(me, row({ attachedBy: "other/2", attachLeaseUntil: past() }))).toBe(
      true,
    );
    // Queued again (reset), or a new attempt with another supervisor: left behind.
    expect(
      agentLeftBehind(
        me,
        row({ execState: null, execPid: null, attachedBy: null, attachLeaseUntil: null }),
      ),
    ).toBe(true);
    expect(agentLeftBehind(me, row({ execPid: 99, attachedBy: "other/2" }))).toBe(true);
    expect(agentLeftBehind(me, undefined)).toBe(true);
    // A job that never started an agent leaves nothing behind.
    expect(agentLeftBehind({ token: "me/1", agent: null }, row({}))).toBe(false);
  });

  it("signals the left-behind agent, scoped to its pid, before the hold lets go", async () => {
    mockUpdateReturning.mockResolvedValue([{ id: "x" }]);
    mockSelectRows.mockResolvedValueOnce([
      { execState: "started", execPid: 77, attachedBy: "me/1", attachLeaseUntil: future() },
    ]);
    mockGetPod.mockResolvedValueOnce({ id: "pod-1", podId: "p1", podName: "pod-1" });
    mockKillRun.mockResolvedValueOnce(true);
    const h = startHold(ref, "me/1", { agent });
    await endRunJob(h, null);
    expect(mockKillRun).toHaveBeenCalledWith(
      { id: "p1", name: "pod-1" },
      { runId: "run-1", runDir: "/home/agent/optio/runs/run-1", signal: "TERM", pid: 77 },
    );
    expect(heldRunCount()).toBe(0);
  });

  it("a reset run's agent is stopped too; a finished or detached job's never is", async () => {
    mockUpdateReturning.mockResolvedValue([{ id: "x" }]);
    mockSelectRows.mockResolvedValueOnce([
      { execState: null, execPid: null, attachedBy: null, attachLeaseUntil: null },
    ]);
    mockGetPod.mockResolvedValue({ id: "pod-1", podId: "p1", podName: "pod-1" });
    mockKillRun.mockResolvedValue(true);
    await endRunJob(startHold(ref, "me/1", { agent }), "reset");
    expect(mockKillRun).toHaveBeenCalledTimes(1);

    await endRunJob(startHold(ref, "me/1", { agent }), "finished");
    await endRunJob(startHold(ref, "me/1", { agent }), "detached");
    await endRunJob(startHold(ref, "me/1"), null);
    expect(mockKillRun).toHaveBeenCalledTimes(1);
    expect(mockSelectRows).toHaveBeenCalledTimes(1);
    mockGetPod.mockReset();
    mockKillRun.mockReset();
  });
});

describe("run directories", () => {
  it("removes only /home/agent/optio/runs/<one plain segment>", () => {
    expect(isRemovableRunDir("/home/agent/optio/runs/0f2e1c1a-1111-4222-8333-444444444444")).toBe(
      true,
    );
    expect(isRemovableRunDir("/home/agent/optio/runs/run_1.v2")).toBe(true);
    for (const bad of [
      "/home/agent/optio/runs/.",
      "/home/agent/optio/runs/..",
      "/home/agent/optio/runs/",
      "/home/agent/optio/runs",
      "/home/agent/optio/runs/.hidden",
      "/home/agent/optio/runs/a/b",
      "/home/agent/optio/runs/../etc",
      "/home/agent/optio/runs/a b",
      "/home/agent/optio/runs/$(id)",
      "/home/agent/optio/runsx/a",
      "/etc",
      "relative/runs/a",
    ]) {
      expect(isRemovableRunDir(bad), bad).toBe(false);
    }
  });

  function execRuntime(stdout: string) {
    const scripts: string[] = [];
    const runtime = {
      exec: vi.fn(async (_h: unknown, cmd: string[]) => {
        scripts.push(cmd[2]);
        return { stdout: Readable.from([Buffer.from(stdout)]), close: vi.fn() };
      }),
    } as unknown as ContainerRuntime;
    return { runtime, scripts };
  }

  it("reads the stderr tail and removes the directory in one exec, logging the tail", async () => {
    const { runtime, scripts } = execRuntime("Error: boom\n");
    mockLog.warn.mockClear();
    const tail = await removeRunDirectory(
      runtime,
      { id: "pod", name: "pod" },
      "/home/agent/optio/runs/run-1",
      mockLog as never,
    );
    expect(tail).toBe("Error: boom");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("tail -c 8192 '/home/agent/optio/runs/run-1/stderr.log'");
    expect(scripts[0]).toContain("rm -rf '/home/agent/optio/runs/run-1'");
    expect(scripts[0].indexOf("tail -c")).toBeLessThan(scripts[0].indexOf("rm -rf"));
    expect(mockLog.warn).toHaveBeenCalledWith({ stderrTail: "Error: boom" }, "Agent stderr output");
  });

  it("refuses anything but a run directory, without an exec", async () => {
    const { runtime } = execRuntime("");
    expect(
      await removeRunDirectory(runtime, { id: "pod", name: "pod" }, "/home/agent/optio/runs/.."),
    ).toBe("");
    expect(runtime.exec).not.toHaveBeenCalled();
  });

  it("a failure message carries the stderr tail when there is one", () => {
    expect(withStderr("Agent failed", "")).toBe("Agent failed");
    expect(withStderr("Agent failed", "  \n")).toBe("Agent failed");
    expect(withStderr("Agent failed", "claude: not found\n")).toBe(
      "Agent failed\n\nAgent stderr (last 8 KB):\nclaude: not found",
    );
  });
});

describe("endRunJob after shutdown let the run go", () => {
  it("gives the lease up again: a start recorded since took a fresh one", async () => {
    vi.useFakeTimers();
    try {
      mockUpdateReturning.mockResolvedValue([{ id: "x" }]);
      const h = startHold({ kind: "work-run", id: "late" }, "me/late", {
        agent: { podId: "pod-1", pid: 5 },
      });
      // Shutdown: every lease given up, the hold released.
      await detachAll();
      expect(h.released).toBe(true);
      mockUpdateSet.mockClear();
      await endRunJob(h, "detached");
      const releases = mockUpdateSet.mock.calls
        .map((c) => c[0] as { attachLeaseUntil?: Date })
        .filter((v) => v.attachLeaseUntil);
      expect(releases).toHaveLength(1);
      expect(mockKillRun).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("onStreamError: an error past the start is the instance's, not the run's", () => {
  const agent = { podId: "pod-1", pid: 7 };

  it("is no business of a job still setting the run up", async () => {
    const h = startHold(ref, "me/1", { agent });
    expect(await onStreamError(h)).toBeNull();
    expect(await onStreamError(null)).toBeNull();
    await h.end();
  });

  it("a job that failed while streaming detaches: its lease goes, its agent stays", async () => {
    mockUpdateReturning.mockResolvedValue([{ id: "x" }]);
    const h = startHold(ref, "me/1", { agent, phase: "streaming", origin: "start" });
    mockKillRun.mockClear();
    // Shutdown already ran in this file: every such error detaches.
    expect(await onStreamError(h)).toBe("detached");
    await endRunJob(h, null);
    expect(mockKillRun).not.toHaveBeenCalled();
    expect(heldRunCount()).toBe(0);
  });
});
