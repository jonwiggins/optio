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

  it("keeps the real user ZDOTDIR when the daemon itself runs inside an Optio terminal", () => {
    const prev = {
      SHELL: process.env.SHELL,
      ZDOTDIR: process.env.ZDOTDIR,
      U: process.env.OPTIO_USER_ZDOTDIR,
    };
    process.env.SHELL = "/bin/zsh";
    // What an outer daemon's wrapper leaves in the environment.
    process.env.ZDOTDIR = "/Users/me/.config/optio/local/zsh";
    process.env.OPTIO_USER_ZDOTDIR = "/Users/me";
    try {
      const { manager } = setup({ shimDir: "/opt/optio/bin", zdotDir: "/opt/optio/zsh" });
      spawnTerminal(manager, "t-1");
      const env = h.spawned[0].spawnOpts.env;
      expect(env.ZDOTDIR).toBe("/opt/optio/zsh");
      expect(env.OPTIO_USER_ZDOTDIR).toBe("/Users/me");
    } finally {
      process.env.SHELL = prev.SHELL;
      if (prev.ZDOTDIR === undefined) delete process.env.ZDOTDIR;
      else process.env.ZDOTDIR = prev.ZDOTDIR;
      if (prev.U === undefined) delete process.env.OPTIO_USER_ZDOTDIR;
      else process.env.OPTIO_USER_ZDOTDIR = prev.U;
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

describe("a terminal whose process exited", () => {
  // The final preview waits on the screen model, so the exit frame goes out
  // a little after the process ends.
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it("stays attachable until its final frames are out", async () => {
    const { sent, manager } = setup();
    spawnTerminal(manager, "t-1");
    h.spawned[0].dataCb?.("hi\r\n");
    h.spawned[0].exitCb?.({ exitCode: 0 });

    // A viewer attaching right after the exit (the server still has the row
    // running) gets the output, not "Unknown terminal".
    expect(manager.has("t-1")).toBe(true);
    expect(manager.isLive("t-1")).toBe(false);
    manager.attach("t-1", "a-1");
    const scrollback = sent.find((m) => m.type === "scrollback") as
      | { attachId: string; dataB64: string }
      | undefined;
    expect(scrollback?.attachId).toBe("a-1");
    expect(Buffer.from(scrollback!.dataB64, "base64").toString()).toBe("hi\r\n");
    expect(sent.some((m) => m.type === "attach-error")).toBe(false);
    // Still reported running in a reconnect hello until its exit is out.
    expect(manager.terminalsSync()).toEqual([{ terminalId: "t-1", running: true }]);

    await settle();
    const types = sent.map((m) => m.type);
    expect(types.indexOf("scrollback")).toBeLessThan(types.indexOf("snapshot"));
    expect(types.indexOf("snapshot")).toBeLessThan(types.indexOf("exit"));
    expect(sent.find((m) => m.type === "exit")).toEqual({
      type: "exit",
      terminalId: "t-1",
      exitCode: 0,
    });

    // Forgotten only once the exit is out.
    expect(manager.has("t-1")).toBe(false);
    expect(manager.terminalsSync()).toEqual([]);
    manager.attach("t-1", "a-2");
    expect(sent.at(-1)).toMatchObject({ type: "attach-error", attachId: "a-2" });
  });

  it("ignores input, resize and kill once the process is gone", async () => {
    const { sent, manager } = setup();
    spawnTerminal(manager, "t-1");
    const pty = h.spawned[0];
    pty.exitCb?.({ exitCode: 0 });
    const before = sent.length;

    manager.input("t-1", Buffer.from("ls\r").toString("base64"));
    manager.resize("t-1", 100, 40);
    manager.kill("t-1");

    expect(pty.written).toEqual([]);
    expect(pty.killed).toEqual([]);
    expect(sent.slice(before).filter((m) => m.type === "size")).toEqual([]);
    await settle();
  });

  it("reports its real exit code once when the daemon shuts down mid-flush", async () => {
    const { sent, manager } = setup();
    spawnTerminal(manager, "t-1");
    h.spawned[0].exitCb?.({ exitCode: 3 });

    manager.killAll();
    await settle();

    expect(sent.filter((m) => m.type === "exit")).toEqual([
      { type: "exit", terminalId: "t-1", exitCode: 3 },
    ]);
    // No signal to a process that is already gone.
    expect(h.spawned[0].killed).toEqual([]);
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

describe("links and preview from the screen model", () => {
  const flush = () => new Promise((r) => setTimeout(r, 30));
  const linkFrames = (sent: LocalDaemonMessage[]) =>
    sent.filter((m): m is Extract<LocalDaemonMessage, { type: "links" }> => m.type === "links");

  it("reports links as they read on screen, not fragments from cell-diffed repaints", async () => {
    vi.useFakeTimers();
    try {
      const { sent, manager } = setup({
        getRepoUrlForDir: () => "https://github.com/jonwiggins/optio",
      });
      spawnTerminal(manager, "t-1");
      // The URL is painted once; later frames repaint a few changed cells on
      // other rows. Flattened to text the stream reads "…/jonwi" + "ns/optio/
      // pull/607" and "#6" + "07"; on screen those cells were never adjacent.
      h.spawned[0].dataCb?.(
        "I was tagged on https://github.com/jonwi\x1b[3;1Hns/optio/pull/607\x1b[1;41Hggins/optio/pull/607 (#6\x1b[4;1H07\x1b[1;65H07)",
      );
      await vi.advanceTimersByTimeAsync(2100);
      vi.useRealTimers();
      await flush();
      const frames = linkFrames(sent);
      expect(frames).toHaveLength(1);
      expect(frames[0].links.map((l) => l.url)).toEqual([
        "https://github.com/jonwiggins/optio/pull/607",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("remembers a link after the screen that showed it is gone", async () => {
    vi.useFakeTimers();
    try {
      const { sent, manager } = setup();
      spawnTerminal(manager, "t-1");
      h.spawned[0].dataCb?.("\x1b[?1049h\x1b[Hsee https://github.com/jonwiggins/optio/pull/1\r\n");
      await vi.advanceTimersByTimeAsync(2100);
      h.spawned[0].dataCb?.("\x1b[2J\x1b[Hnothing here\r\n");
      await vi.advanceTimersByTimeAsync(2100);
      vi.useRealTimers();
      await flush();
      const frames = linkFrames(sent);
      expect(frames).toHaveLength(1);
      expect(frames[0].links.map((l) => l.url)).toEqual([
        "https://github.com/jonwiggins/optio/pull/1",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the final preview and snapshot before the exit frame", async () => {
    const { sent, manager } = setup();
    spawnTerminal(manager, "t-1");
    h.spawned[0].dataCb?.("last words\r\n");
    h.spawned[0].exitCb?.({ exitCode: 0 });
    await flush();
    const types = sent.map((m) => m.type);
    expect(types.indexOf("preview")).toBeGreaterThan(-1);
    expect(types.indexOf("preview")).toBeLessThan(types.indexOf("exit"));
    expect(types.indexOf("snapshot")).toBeLessThan(types.indexOf("exit"));
    const preview = sent.find((m) => m.type === "preview") as { preview: string };
    expect(preview.preview).toBe("last words");
  });
});
