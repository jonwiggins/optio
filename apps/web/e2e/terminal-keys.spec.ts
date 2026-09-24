/**
 * Keys reach a Local terminal the way a Mac terminal sends them. xterm.js
 * keys its Mac rules off navigator.platform, unless it believes it runs
 * under Node — which Next's `process` polyfill once made it believe (see
 * next.config.ts). Then ⌥↑ went out as Ctrl+↑, and Codex's "answer the
 * question" key never arrived.
 *
 * The browser claims to be a Mac (so this holds on Linux CI too). The test
 * plays the seeded laptop's daemon over the real protocol, so the bytes are
 * checked where a PTY would get them: browser → API relay → daemon.
 */
import { expect, test } from "@playwright/test";

const API = "http://127.0.0.1:4931";

type Frame = Record<string, any>;

/** Just enough of `optio local up` to start a terminal and record its input. */
async function fakeDaemon(hostId: string, dirs: unknown[]) {
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
      send({ type: "scrollback", terminalId: msg.terminalId, attachId: msg.attachId, dataB64: "" });
    }
    if (msg.type === "input") input.push(Buffer.from(msg.dataB64, "base64").toString("utf-8"));
    if (msg.type === "kill") send({ type: "exit", terminalId: msg.terminalId, exitCode: 0 });
  };
  send({ type: "hello", hostId, daemonVersion: "0.0.0-e2e", dirs, terminals: [] });
  return { input, close: () => ws.close() };
}

test("Option+arrows reach a Local terminal as Alt+arrows on a Mac", async ({ page, request }) => {
  const { hosts } = await (await request.get(`${API}/api/local/hosts`)).json();
  const laptop = hosts.find((h: { name: string }) => h.name === "E2E laptop");
  const daemon = await fakeDaemon(laptop.id, laptop.dirs);
  try {
    const created = await request.post(`${API}/api/local/terminals`, {
      data: { hostId: laptop.id, dir: "/Users/e2e/notes", title: "keys", spec: { kind: "shell" } },
    });
    expect(created.ok()).toBe(true);
    const { terminal } = await created.json();
    await expect
      .poll(
        async () =>
          (await (await request.get(`${API}/api/local/terminals/${terminal.id}`)).json()).terminal
            .state,
      )
      .toBe("running");

    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });
    });
    await page.goto(`/local/${terminal.id}`);
    const keys = page.locator(".xterm-helper-textarea").first();
    await keys.waitFor({ state: "attached", timeout: 30_000 });
    // Typing reaches the daemon once the stream is up.
    await expect
      .poll(async () => {
        await keys.focus();
        await page.keyboard.type("x");
        return daemon.input.includes("x");
      })
      .toBe(true);
    daemon.input.length = 0;

    await page.keyboard.press("Alt+ArrowUp");
    await page.keyboard.press("Alt+ArrowDown");
    await page.keyboard.press("Shift+ArrowLeft");
    await expect.poll(() => daemon.input.join("")).toBe("\x1b[1;3A\x1b[1;3B\x1b[1;2D");

    await request.post(`${API}/api/local/terminals/${terminal.id}/kill`);
    await expect
      .poll(
        async () =>
          (await (await request.get(`${API}/api/local/terminals/${terminal.id}`)).json()).terminal
            .state,
      )
      .toBe("exited");
    await request.delete(`${API}/api/local/terminals/${terminal.id}`);
  } finally {
    daemon.close();
  }
});
