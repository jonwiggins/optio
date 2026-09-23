/**
 * Integration tests for stored agent conversations (local_terminal_transcripts)
 * against real Postgres: the daemon's `transcript` frames land as rows keyed
 * by seq, re-sends are no-ops, only the owning host may write, only while
 * the terminal is live, and deleting the terminal takes the rows with it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_TRANSCRIPT_TEXT_MAX, type LocalTranscriptEntry } from "@optio/shared";
import * as relay from "./local-relay.js";
import { registerHost } from "./local-host-service.js";
import {
  countTranscript,
  createTerminal,
  deleteTerminal,
  getTerminal,
  getTranscript,
  handleExit,
  handleSession,
  handleStarted,
  handleTranscript,
  handleTranscriptBackfill,
  requestTranscriptBackfill,
  resetTranscriptBackfillsForTests,
  sanitizeTranscriptEntries,
} from "./local-terminal-service.js";

class FakeDaemonSocket implements relay.RelaySocket {
  readyState = 1;
  sent: string[] = [];
  send(data: string | Buffer) {
    this.sent.push(String(data));
  }
  close() {
    this.readyState = 3;
  }
  requests(): Array<Record<string, string>> {
    return this.sent
      .map((s) => JSON.parse(s) as Record<string, string>)
      .filter((m) => m.type === "transcript-request");
  }
}

async function makeHost(capabilities: { transcriptBackfill?: boolean } = {}) {
  const host = await registerHost({
    userId: null,
    workspaceId: null,
    hostname: `it-transcript-${Math.random().toString(36).slice(2, 8)}`,
    platform: "darwin",
    arch: "arm64",
    daemonVersion: "0.1.0",
    dirs: [{ path: "/home/dev/scratch" }],
  });
  const daemon = new FakeDaemonSocket();
  relay.registerDaemon(host.id, null, daemon, capabilities);
  return Object.assign(host, { daemon });
}

async function runningAgentTerminal(
  opts: { agent?: "claude-code" | "codex"; transcriptBackfill?: boolean } = {},
) {
  const host = await makeHost({ transcriptBackfill: opts.transcriptBackfill });
  const terminal = await createTerminal({
    host,
    userId: null,
    workspaceId: null,
    dir: "/home/dev/scratch",
    spec: { kind: "agent", agent: opts.agent ?? "claude-code", prompt: "hi" },
  });
  await handleStarted(host.id, terminal.id);
  return { host, terminal: (await getTerminal(terminal.id))! };
}

const SESSION = "c1545b8e-d116-4761-8921-38509a508395";

/** An agent session that ran and ended without streaming its conversation. */
async function finishedSession(
  opts: { agent?: "claude-code" | "codex"; transcriptBackfill?: boolean; session?: boolean } = {},
) {
  const { host, terminal } = await runningAgentTerminal({
    agent: opts.agent,
    transcriptBackfill: opts.transcriptBackfill ?? true,
  });
  if (opts.session ?? true) await handleSession(host.id, terminal.id, SESSION);
  await handleExit(host.id, terminal.id, 143);
  return { host, terminal: (await getTerminal(terminal.id))! };
}

const entry = (seq: number, over: Partial<LocalTranscriptEntry> = {}): LocalTranscriptEntry => ({
  seq,
  role: "assistant",
  kind: "text",
  text: `reply ${seq}`,
  detail: null,
  toolName: null,
  toolUseId: null,
  isError: false,
  at: "2026-09-19T20:00:00.000Z",
  ...over,
});

beforeEach(() => {
  relay.resetRelayForTests();
  resetTranscriptBackfillsForTests();
});
afterEach(() => relay.resetRelayForTests());

describe("sanitizeTranscriptEntries", () => {
  it("drops malformed entries and bounds the rest", () => {
    const clean = sanitizeTranscriptEntries([
      entry(1),
      { seq: 2, role: "robot", kind: "text", text: "x" },
      { seq: 3, role: "user", kind: "text" },
      { seq: 1.5, role: "user", kind: "text", text: "x" },
      entry(1, { text: "dup seq" }),
      entry(4, { text: "y".repeat(LOCAL_TRANSCRIPT_TEXT_MAX + 10), at: "not a date" }),
      "nope",
    ]);
    expect(clean.map((e) => e.seq)).toEqual([1, 4]);
    expect(clean[1]!.text).toHaveLength(LOCAL_TRANSCRIPT_TEXT_MAX);
    expect(clean[1]!.at).toBeNull();
  });
});

describe("handleTranscript / getTranscript", () => {
  it("stores entries in seq order and ignores a re-sent batch", async () => {
    const { host, terminal } = await runningAgentTerminal();
    expect(
      await handleTranscript(host.id, terminal.id, [
        entry(1, { role: "user", text: "fix it" }),
        entry(2, { kind: "tool_use", toolName: "Bash", toolUseId: "t1", text: "npm test" }),
        entry(3, {
          role: "tool",
          kind: "tool_result",
          toolUseId: "t1",
          text: "ok",
          isError: false,
        }),
      ]),
    ).toBe(3);
    expect(await handleTranscript(host.id, terminal.id, [entry(2), entry(3), entry(4)])).toBe(1);

    const all = await getTranscript(terminal.id);
    expect(all.map((e) => [e.seq, e.role, e.kind, e.text])).toEqual([
      [1, "user", "text", "fix it"],
      [2, "assistant", "tool_use", "npm test"],
      [3, "tool", "tool_result", "ok"],
      [4, "assistant", "text", "reply 4"],
    ]);
    expect(all[1]).toMatchObject({
      toolName: "Bash",
      toolUseId: "t1",
      at: "2026-09-19T20:00:00.000Z",
    });
    expect(await getTranscript(terminal.id, 2)).toHaveLength(2);
    expect(await getTranscript(terminal.id, 0, 1)).toHaveLength(1);
    expect(await countTranscript(terminal.id)).toBe(4);
  });

  it("refuses writes from another host and after the terminal exited", async () => {
    const { host, terminal } = await runningAgentTerminal();
    const other = await makeHost();
    expect(await handleTranscript(other.id, terminal.id, [entry(1)])).toBe(0);
    expect(await handleTranscript(host.id, terminal.id, [entry(1)])).toBe(1);
    await handleExit(host.id, terminal.id, 0);
    expect(await handleTranscript(host.id, terminal.id, [entry(2)])).toBe(0);
    expect(await countTranscript(terminal.id)).toBe(1);
  });

  it("goes away with the terminal", async () => {
    const { host, terminal } = await runningAgentTerminal();
    await handleTranscript(host.id, terminal.id, [entry(1), entry(2)]);
    await handleExit(host.id, terminal.id, 0);
    await deleteTerminal((await getTerminal(terminal.id))!);
    expect(await countTranscript(terminal.id)).toBe(0);
  });
});

describe("transcript backfill", () => {
  it("asks a finished session's host for its conversation and stores the answer", async () => {
    const { host, terminal } = await finishedSession();
    expect(requestTranscriptBackfill(terminal)).toBe(true);
    const [req] = host.daemon.requests();
    expect(req).toMatchObject({
      terminalId: terminal.id,
      agent: "claude-code",
      agentSessionId: SESSION,
    });
    // In flight: asking again waits on the same request.
    expect(requestTranscriptBackfill(terminal)).toBe(true);
    expect(host.daemon.requests()).toHaveLength(1);

    // Only the answer to that request, from that host, is stored.
    const other = await makeHost();
    const answer = { requestId: req!.requestId, terminalId: terminal.id };
    expect(
      await handleTranscriptBackfill(host.id, {
        ...answer,
        requestId: "guess",
        entries: [entry(1)],
      }),
    ).toBe(0);
    expect(await handleTranscriptBackfill(other.id, { ...answer, entries: [entry(1)] })).toBe(0);

    expect(
      await handleTranscriptBackfill(host.id, { ...answer, entries: [entry(1), entry(2)] }),
    ).toBe(2);
    expect(
      await handleTranscriptBackfill(host.id, { ...answer, entries: [entry(3)], done: true }),
    ).toBe(1);
    expect((await getTranscript(terminal.id)).map((e) => e.seq)).toEqual([1, 2, 3]);

    // Answered: a late frame is dropped and nothing more is asked.
    expect(
      await handleTranscriptBackfill(host.id, { ...answer, entries: [entry(4)], done: true }),
    ).toBe(0);
    expect(requestTranscriptBackfill(terminal)).toBe(false);
    expect(await countTranscript(terminal.id)).toBe(3);
  });

  it("waits a while before asking again when the host had nothing", async () => {
    const { host, terminal } = await finishedSession();
    const now = Date.now();
    expect(requestTranscriptBackfill(terminal, now)).toBe(true);
    const [req] = host.daemon.requests();
    await handleTranscriptBackfill(host.id, {
      requestId: req!.requestId,
      terminalId: terminal.id,
      entries: [],
      done: true,
      error: "No transcript for this session on this machine",
    });
    expect(requestTranscriptBackfill(terminal, Date.now() + 60_000)).toBe(false);
    expect(requestTranscriptBackfill(terminal, Date.now() + 11 * 60_000)).toBe(true);
    expect(host.daemon.requests()).toHaveLength(2);
  });

  it("asks again when a request goes unanswered", async () => {
    const { host, terminal } = await finishedSession();
    const now = Date.now();
    expect(requestTranscriptBackfill(terminal, now)).toBe(true);
    expect(requestTranscriptBackfill(terminal, now + 5_000)).toBe(true);
    expect(host.daemon.requests()).toHaveLength(1);
    expect(requestTranscriptBackfill(terminal, now + 25_000)).toBe(true);
    const [first, second] = host.daemon.requests();
    expect(second!.requestId).not.toBe(first!.requestId);
    // The superseded request's answer no longer counts.
    expect(
      await handleTranscriptBackfill(host.id, {
        requestId: first!.requestId,
        terminalId: terminal.id,
        entries: [entry(1)],
        done: true,
      }),
    ).toBe(0);
  });

  it("only asks about finished Claude Code sessions with a session id, on hosts that can answer", async () => {
    const running = await runningAgentTerminal({ transcriptBackfill: true });
    expect(requestTranscriptBackfill(running.terminal)).toBe(false);

    const noSession = await finishedSession({ session: false });
    expect(requestTranscriptBackfill(noSession.terminal)).toBe(false);

    const codex = await finishedSession({ agent: "codex" });
    expect(requestTranscriptBackfill(codex.terminal)).toBe(false);

    const oldDaemon = await finishedSession({ transcriptBackfill: false });
    expect(requestTranscriptBackfill(oldDaemon.terminal)).toBe(false);

    const offline = await finishedSession();
    relay.unregisterDaemon(offline.host.id, offline.host.daemon);
    expect(requestTranscriptBackfill(offline.terminal)).toBe(false);

    for (const h of [running, noSession, codex, oldDaemon, offline]) {
      expect(h.host.daemon.requests()).toHaveLength(0);
    }
  });
});
