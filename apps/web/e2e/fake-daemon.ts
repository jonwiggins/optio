/**
 * Just enough of `optio local up` to give a browser a live Local terminal in
 * the e2e stack: it plays the seeded laptop's daemon over the real protocol
 * (`/ws/local/daemon`), starts what the server spawns, paints `screen` for
 * each viewer that attaches, and records the keystrokes the browser sends —
 * the bytes a PTY would get — and the resizes, each echoed as the PTY's new
 * grid the way terminal-manager.ts does.
 */
import type { APIRequestContext } from "@playwright/test";
import { expect } from "@playwright/test";

export const API = "http://127.0.0.1:4931";

type Frame = Record<string, any>;

type Grid = { cols: number; rows: number };

/**
 * What the daemon hands a viewer that attaches: fixed text, or drawn for the
 * PTY's grid. `snapshotGrid` names that grid in the `scrollback` frame, as a
 * daemon with a screen model does (the relay then sends a `replay` frame).
 */
type ScreenOpts = {
  screen?: string | ((grid: Grid) => string);
  snapshotGrid?: boolean;
  /** Say in the hello that the daemon answers its terminals' queries, as `optio local up` does. */
  answersQueries?: boolean;
};

export async function fakeDaemon(hostId: string, dirs: unknown[], opts: ScreenOpts = {}) {
  const input: string[] = [];
  const resizes: Grid[] = [];
  const grids = new Map<string, Grid>();
  const ws = new WebSocket(`${API.replace("http", "ws")}/ws/local/daemon`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("fake daemon: connect failed"));
  });
  const send = (msg: Frame) => ws.send(JSON.stringify(msg));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as Frame;
    if (msg.type === "spawn") {
      grids.set(msg.terminalId, { cols: msg.cols ?? 120, rows: msg.rows ?? 32 });
      send({ type: "started", terminalId: msg.terminalId });
    }
    if (msg.type === "attach") {
      const grid = grids.get(msg.terminalId) ?? { cols: 120, rows: 32 };
      const screen = typeof opts.screen === "function" ? opts.screen(grid) : (opts.screen ?? "");
      const dataB64 = Buffer.from(screen, "utf-8").toString("base64");
      send({
        type: "scrollback",
        terminalId: msg.terminalId,
        attachId: msg.attachId,
        dataB64,
        ...(opts.snapshotGrid ? grid : {}),
      });
      send({ type: "size", terminalId: msg.terminalId, ...grid });
    }
    if (msg.type === "resize") {
      const grid = { cols: msg.cols, rows: msg.rows };
      grids.set(msg.terminalId, grid);
      resizes.push(grid);
      send({ type: "size", terminalId: msg.terminalId, ...grid });
    }
    if (msg.type === "input") input.push(Buffer.from(msg.dataB64, "base64").toString("utf-8"));
    if (msg.type === "kill") send({ type: "exit", terminalId: msg.terminalId, exitCode: 0 });
  };
  send({
    type: "hello",
    hostId,
    daemonVersion: "0.0.0-e2e",
    dirs,
    terminals: [],
    ...(opts.answersQueries ? { answersQueries: true } : {}),
  });
  /** Live output from the terminal, as a program would print it. */
  const output = (terminalId: string, text: string) =>
    send({ type: "output", terminalId, dataB64: Buffer.from(text, "utf-8").toString("base64") });
  return { input, resizes, output, close: () => ws.close() };
}

const terminalState = async (request: APIRequestContext, id: string) =>
  (await (await request.get(`${API}/api/local/terminals/${id}`)).json()).terminal.state;

/**
 * A running shell terminal on the seeded "E2E laptop", served by a fake
 * daemon. `done()` kills and deletes it and disconnects the daemon.
 */
export async function liveTerminal(
  request: APIRequestContext,
  opts: { title: string } & ScreenOpts,
) {
  const { hosts } = await (await request.get(`${API}/api/local/hosts`)).json();
  const laptop = hosts.find((h: { name: string }) => h.name === "E2E laptop");
  const daemon = await fakeDaemon(laptop.id, laptop.dirs, {
    screen: opts.screen,
    snapshotGrid: opts.snapshotGrid,
    answersQueries: opts.answersQueries,
  });
  const created = await request.post(`${API}/api/local/terminals`, {
    data: {
      hostId: laptop.id,
      dir: "/Users/e2e/notes",
      title: opts.title,
      spec: { kind: "shell" },
    },
  });
  expect(created.ok()).toBe(true);
  const { terminal } = await created.json();
  await expect.poll(() => terminalState(request, terminal.id)).toBe("running");
  return {
    id: terminal.id as string,
    input: daemon.input,
    /** Every resize the PTY got, in order. */
    resizes: daemon.resizes,
    /** Print `text` in the terminal, live. */
    output: (text: string) => daemon.output(terminal.id, text),
    async done() {
      try {
        await request.post(`${API}/api/local/terminals/${terminal.id}/kill`);
        await expect.poll(() => terminalState(request, terminal.id)).toBe("exited");
        await request.delete(`${API}/api/local/terminals/${terminal.id}`);
      } finally {
        daemon.close();
      }
    },
  };
}
