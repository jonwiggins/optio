/**
 * Just enough of `optio local up` to give a browser a live Local terminal in
 * the e2e stack: it plays the seeded laptop's daemon over the real protocol
 * (`/ws/local/daemon`), starts what the server spawns, paints `screen` for
 * each viewer that attaches, and records the keystrokes the browser sends —
 * the bytes a PTY would get.
 */
import type { APIRequestContext } from "@playwright/test";
import { expect } from "@playwright/test";

export const API = "http://127.0.0.1:4931";

type Frame = Record<string, any>;

export async function fakeDaemon(hostId: string, dirs: unknown[], opts: { screen?: string } = {}) {
  const input: string[] = [];
  const ws = new WebSocket(`${API.replace("http", "ws")}/ws/local/daemon`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("fake daemon: connect failed"));
  });
  const send = (msg: Frame) => ws.send(JSON.stringify(msg));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as Frame;
    if (msg.type === "spawn") send({ type: "started", terminalId: msg.terminalId });
    if (msg.type === "attach") {
      const dataB64 = Buffer.from(opts.screen ?? "", "utf-8").toString("base64");
      send({ type: "scrollback", terminalId: msg.terminalId, attachId: msg.attachId, dataB64 });
    }
    if (msg.type === "input") input.push(Buffer.from(msg.dataB64, "base64").toString("utf-8"));
    if (msg.type === "kill") send({ type: "exit", terminalId: msg.terminalId, exitCode: 0 });
  };
  send({ type: "hello", hostId, daemonVersion: "0.0.0-e2e", dirs, terminals: [] });
  return { input, close: () => ws.close() };
}

const terminalState = async (request: APIRequestContext, id: string) =>
  (await (await request.get(`${API}/api/local/terminals/${id}`)).json()).terminal.state;

/**
 * A running shell terminal on the seeded "E2E laptop", served by a fake
 * daemon. `done()` kills and deletes it and disconnects the daemon.
 */
export async function liveTerminal(
  request: APIRequestContext,
  opts: { title: string; screen?: string },
) {
  const { hosts } = await (await request.get(`${API}/api/local/hosts`)).json();
  const laptop = hosts.find((h: { name: string }) => h.name === "E2E laptop");
  const daemon = await fakeDaemon(laptop.id, laptop.dirs, { screen: opts.screen });
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
