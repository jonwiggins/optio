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
  handleStarted,
  handleTranscript,
  sanitizeTranscriptEntries,
} from "./local-terminal-service.js";

class FakeDaemonSocket implements relay.RelaySocket {
  readyState = 1;
  send() {}
  close() {
    this.readyState = 3;
  }
}

async function makeHost() {
  const host = await registerHost({
    userId: null,
    workspaceId: null,
    hostname: `it-transcript-${Math.random().toString(36).slice(2, 8)}`,
    platform: "darwin",
    arch: "arm64",
    daemonVersion: "0.1.0",
    dirs: [{ path: "/home/dev/scratch" }],
  });
  relay.registerDaemon(host.id, null, new FakeDaemonSocket());
  return host;
}

async function runningAgentTerminal() {
  const host = await makeHost();
  const terminal = await createTerminal({
    host,
    userId: null,
    workspaceId: null,
    dir: "/home/dev/scratch",
    spec: { kind: "agent", agent: "claude-code", prompt: "hi" },
  });
  await handleStarted(host.id, terminal.id);
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

beforeEach(() => relay.resetRelayForTests());
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
