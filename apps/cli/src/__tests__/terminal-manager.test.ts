import os from "node:os";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LocalDaemonMessage } from "@optio/shared";
import { AttentionTracker } from "../local/attention.js";
import {
  TerminalManager,
  scrubSpawnEnv,
  type TerminalManagerOptions,
} from "../local/terminal-manager.js";

const h = vi.hoisted(() => {
  class FakePty {
    dataCb: ((data: string) => void) | null = null;
    exitCb: ((event: { exitCode: number; signal?: number }) => void) | null = null;
    written: string[] = [];
    killed: string[] = [];

    onData(cb: (data: string) => void) {
      this.dataCb = cb;
      return { dispose: () => {} };
    }

    onExit(cb: (event: { exitCode: number; signal?: number }) => void) {
      this.exitCb = cb;
      return { dispose: () => {} };
    }

    write(data: string) {
      this.written.push(data);
    }

    cols = 80;
    rows = 24;
    spawnFile = "";
    spawnArgs: string[] = [];
    spawnOpts: any = null;
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }

    kill(signal?: string) {
      this.killed.push(signal ?? "SIGTERM");
    }
  }
  const spawned: InstanceType<typeof FakePty>[] = [];
  return { FakePty, spawned };
});

vi.mock("node-pty", () => ({
  spawn: vi.fn((file: string, args: string[], opts: any) => {
    const pty = new h.FakePty();
    pty.spawnFile = file;
    pty.spawnArgs = args;
    pty.spawnOpts = opts;
    h.spawned.push(pty);
    return pty;
  }),
}));

function setup(extra: Partial<TerminalManagerOptions> = {}) {
  const sent: LocalDaemonMessage[] = [];
  // Mirrors the daemon's wiring: attention events go out as protocol frames.
  // Inert scheduler — no silence timers leak past the test.
  const attention = new AttentionTracker({
    onEvent: (event) =>
      sent.push({
        type: "attention",
        terminalId: event.terminalId,
        state: event.state,
        reason: event.reason,
      }),
    scheduler: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  const manager = new TerminalManager({
    send: (msg) => sent.push(msg),
    attention,
    getAllowedDirs: () => [os.tmpdir()],
    hookSettingsPath: "/tmp/optio-test-hooks.json",
    ...extra,
    getHookServerPort: () => 0,
  });
  return { sent, attention, manager };
}

function spawnTerminal(manager: TerminalManager, terminalId: string) {
  manager.spawn({
    type: "spawn",
    terminalId,
    dir: os.tmpdir(),
    cols: 80,
    rows: 24,
    spec: { kind: "shell" },
  });
}

const outputFrames = (sent: LocalDaemonMessage[]) => sent.filter((m) => m.type === "output");

beforeEach(() => {
  h.spawned.length = 0;
});

describe("output subscription", () => {
  it("does not send output frames before an attach", () => {
    const { sent, manager } = setup();
    spawnTerminal(manager, "t-1");
    expect(sent).toContainEqual({ type: "started", terminalId: "t-1" });
    h.spawned[0].dataCb?.("hello");
    expect(outputFrames(sent)).toEqual([]);
  });

  it("routes zsh spawns through the ZDOTDIR wrapper so the claude shim stays first", () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = "/bin/zsh";
    try {
      const { manager } = setup({ shimDir: "/opt/optio/bin", zdotDir: "/opt/optio/zsh" });
      spawnTerminal(manager, "t-1");
      const env = h.spawned[0].spawnOpts.env;
      expect(env.ZDOTDIR).toBe("/opt/optio/zsh");
      expect(env.OPTIO_USER_ZDOTDIR).toBeTruthy();
      expect(env.OPTIO_LOCAL_SHIM_DIR).toBe("/opt/optio/bin");
      expect(env.PATH.startsWith("/opt/optio/bin:")).toBe(true);
    } finally {
      process.env.SHELL = prevShell;
    }
  });

  it("announces the PTY grid on spawn, after a resize, and to each new attach", () => {
    const { sent, manager } = setup();
    spawnTerminal(manager, "t-1");
    const sizes = () => sent.filter((m) => m.type === "size");
    expect(sizes()).toEqual([{ type: "size", terminalId: "t-1", cols: 80, rows: 24 }]);

    manager.resize("t-1", 45, 30);
    expect(sizes().at(-1)).toEqual({ type: "size", terminalId: "t-1", cols: 45, rows: 30 });

    manager.attach("t-1", "attach-1");
    const idx = sent.findIndex((m) => m.type === "scrollback");
    expect(sent[idx + 1]).toEqual({ type: "size", terminalId: "t-1", cols: 45, rows: 30 });
  });

  it("attach sends scrollback then streams output", () => {
    const { sent, manager } = setup();
    spawnTerminal(manager, "t-1");
    h.spawned[0].dataCb?.("before");
    manager.attach("t-1", "attach-1");
    const scrollback = sent.find((m) => m.type === "scrollback");
    expect(scrollback).toMatchObject({ terminalId: "t-1", attachId: "attach-1" });
    h.spawned[0].dataCb?.("after");
    expect(outputFrames(sent)).toEqual([
      {
        type: "output",
        terminalId: "t-1",
        dataB64: Buffer.from("after", "utf-8").toString("base64"),
      },
    ]);
  });

  it("clearAllSubscriptions stops output until the server re-attaches", () => {
    const { sent, manager } = setup();
    spawnTerminal(manager, "t-1");
    spawnTerminal(manager, "t-2");
    manager.attach("t-1", "a-1");
    manager.attach("t-2", "a-2");

    manager.clearAllSubscriptions();
    h.spawned[0].dataCb?.("dropped");
    h.spawned[1].dataCb?.("dropped");
    expect(outputFrames(sent)).toEqual([]);

    manager.attach("t-1", "a-3");
    h.spawned[0].dataCb?.("resumed");
    h.spawned[1].dataCb?.("still dropped");
    expect(outputFrames(sent)).toEqual([
      {
        type: "output",
        terminalId: "t-1",
        dataB64: Buffer.from("resumed", "utf-8").toString("base64"),
      },
    ]);
  });
});

describe("killAll", () => {
  it("reports an exit for every live terminal, then kills the PTYs", () => {
    const { sent, manager } = setup();
    spawnTerminal(manager, "t-1");
    spawnTerminal(manager, "t-2");

    manager.killAll();

    const exits = sent.filter((m) => m.type === "exit");
    expect(exits).toEqual([
      { type: "exit", terminalId: "t-1", exitCode: null },
      { type: "exit", terminalId: "t-2", exitCode: null },
    ]);
    expect(h.spawned[0].killed).toEqual(["SIGTERM"]);
    expect(h.spawned[1].killed).toEqual(["SIGTERM"]);
    expect(manager.terminalsSync()).toEqual([]);
  });

  it("does not double-report when the PTY's own onExit fires afterwards", () => {
    const { sent, manager } = setup();
    spawnTerminal(manager, "t-1");
    manager.killAll();
    h.spawned[0].exitCb?.({ exitCode: 0 });
    expect(sent.filter((m) => m.type === "exit")).toHaveLength(1);
  });
});

describe("input", () => {
  it("writes to the PTY and signals the attention tracker", () => {
    const { attention, manager } = setup();
    const onInput = vi.spyOn(attention, "onInput");
    spawnTerminal(manager, "t-1");
    manager.input("t-1", Buffer.from("y\n", "utf-8").toString("base64"));
    expect(h.spawned[0].written).toEqual(["y\n"]);
    expect(onInput).toHaveBeenCalledWith("t-1");
  });

  it("input clears a bell-driven needs_you back to working", () => {
    const { sent, manager } = setup();
    spawnTerminal(manager, "t-1");
    h.spawned[0].dataCb?.("confirm? \x07");
    const last = sent.filter((m) => m.type === "attention").at(-1);
    expect(last).toEqual({
      type: "attention",
      terminalId: "t-1",
      state: "needs_you",
      reason: "bell",
    });

    manager.input("t-1", Buffer.from("y", "utf-8").toString("base64"));
    const after = sent.filter((m) => m.type === "attention").at(-1);
    expect(after).toEqual({
      type: "attention",
      terminalId: "t-1",
      state: "working",
      reason: "input",
    });
  });
});

describe("scrubSpawnEnv", () => {
  it("drops inherited Claude Code session markers but keeps user config", () => {
    const env = scrubSpawnEnv({
      PATH: "/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_CODE_OAUTH_TOKEN: "keep-me",
      CLAUDE_CODE_USE_VERTEX: "1",
      UNDEFINED_ONE: undefined,
    });
    expect(env).toEqual({
      PATH: "/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "keep-me",
      CLAUDE_CODE_USE_VERTEX: "1",
    });
  });
});
