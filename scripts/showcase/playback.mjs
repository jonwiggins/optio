/** Real Local protocol, fictional activity. Only connects to a private fake-runtime dev lab. */
import { readFileSync, writeFileSync } from "node:fs";
const port = Number(process.argv[2] ?? 4965);
if (!Number.isInteger(port) || port < 4962 || port > 4979)
  throw new Error("Playback is only for a private dev-lab port");
const manifestPath = `/tmp/optio-showcase-${port}.json`;
const m = JSON.parse(readFileSync(manifestPath, "utf8"));
const api = async (path, data) => {
  const r = await fetch(
    `${m.api}${path}`,
    data
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        }
      : {},
  );
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};
const { hosts } = await api("/api/local/hosts");
const host = hosts.find((h) => h.id === m.hostId);
if (host.hostname !== "optio-showcase.example") throw new Error("Wrong demo host");
const ws = new WebSocket(`${m.api.replace("http", "ws")}/ws/local/daemon`, [
  "optio-ws-v1",
  "optio-auth-demo",
]);
const send = (f) => ws.send(JSON.stringify(f));
const sessions = new Map();
let pong = false;
ws.onmessage = async (ev) => {
  const f = JSON.parse(String(ev.data));
  if (f.type === "pong") pong = true;
  if (f.type === "spawn") send({ type: "started", terminalId: f.terminalId });
  if (f.type === "attach") {
    const s = sessions.get(f.terminalId);
    const text = s?.screen ?? "\x1b[2J\x1b[HExample shell\r\n$";
    send({
      type: "scrollback",
      terminalId: f.terminalId,
      attachId: f.attachId,
      dataB64: Buffer.from(text).toString("base64"),
    });
    send({ type: "size", terminalId: f.terminalId, cols: f.cols ?? 100, rows: f.rows ?? 32 });
  }
  if (f.type === "resize")
    send({ type: "size", terminalId: f.terminalId, cols: f.cols, rows: f.rows });
  if (f.type === "kill") send({ type: "exit", terminalId: f.terminalId, exitCode: 0 });
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
for (let n = 0; n < 20 && !pong; n++) {
  send({
    type: "hello",
    hostId: m.hostId,
    daemonVersion: "showcase-playback",
    dirs: host.dirs,
    terminals: [],
    claudeCredentials: false,
  });
  send({ type: "ping" });
  await new Promise((r) => setTimeout(r, 200));
}
if (!pong) throw new Error("Demo daemon failed to connect");
const records = [
  {
    key: "claude",
    title: "Polish the checkout experience",
    agent: "claude-code",
    attention: "needs_you",
    trigger: m.examples.local,
    query: "Make checkout easier to use from the keyboard. Preserve the payment flow.",
    reply:
      "Ready for your review\n\nThe checkout dialog now keeps focus inside the form and returns it to the trigger when it closes.\n\n• Added Escape to dismiss and clear field labels.\n• Preserved payment validation and submission.\n• Added keyboard navigation coverage.\n\nWould you like me to open a draft PR?",
    screen: [
      "Claude Code  ·  storefront",
      "Example session · simulated activity",
      "",
      "› Polish the checkout experience",
      "",
      "✓ Read CheckoutDialog.tsx and the keyboard tests",
      "✓ Added focus trapping and Escape to dismiss",
      "✓ Preserved the payment validation flow",
      "✓ Added keyboard navigation coverage",
      "",
      "Ready for your review. Open a draft PR?",
    ],
  },
  {
    key: "codex",
    title: "Build a faster product search",
    agent: "codex",
    attention: "working",
    query: "Improve search responsiveness without changing the public API.",
    reply:
      "I’ve added request cancellation and a debounced query. I’m checking the empty, loading, and error states next, including out-of-order responses.",
    screen: [
      "OpenAI Codex  ·  storefront",
      "Example session · simulated activity",
      "",
      "› Improve product search responsiveness",
      "",
      "✓ Read the search component and API contract",
      "✓ Added a debounced query and request cancellation",
      "✓ Kept previous results visible while loading",
      "",
      "Checking empty, loading, and error states…",
    ],
  },
  {
    key: "terminal",
    title: "Storefront terminal",
    agent: null,
    attention: "idle",
    screen: [
      "Storefront  ·  example workspace",
      "",
      "$ pnpm test:smoke",
      "",
      "✓ Product catalog loads",
      "✓ Search preserves query state",
      "✓ Checkout supports keyboard navigation",
      "✓ API health check passes",
      "",
      "4 checks passed · example output",
      "",
      "$",
    ],
  },
];
m.live = {};
for (const s of records) {
  const { terminal: t } = await api("/api/local/terminals", {
    hostId: m.hostId,
    dir: host.dirs[0].path,
    title: s.title,
    spec: s.agent
      ? { kind: "agent", agent: s.agent, mode: "interactive", prompt: s.query }
      : { kind: "shell" },
  });
  s.screen =
    "\x1b[2J\x1b[H" +
    s.screen
      .map((l, i) =>
        i === 0 ? `\x1b[1m${l}\x1b[0m` : l.startsWith("✓") ? `\x1b[32m✓\x1b[0m${l.slice(1)}` : l,
      )
      .join("\r\n") +
    "\r\n";
  sessions.set(t.id, s);
  m.live[s.key] = t.id;
  await new Promise((r) => setTimeout(r, 250));
  send({ type: "attention", terminalId: t.id, state: s.attention, reason: "Example activity" });
  send({
    type: "preview",
    terminalId: t.id,
    preview: s.reply?.replace("## ", "").split("\n")[0] ?? "Example shell ready",
    lastActivityAt: new Date().toISOString(),
  });
  if (s.agent)
    send({
      type: "transcript",
      terminalId: t.id,
      entries: [
        {
          seq: 1,
          role: "user",
          kind: "text",
          text: s.query,
          at: new Date(Date.now() - 150000).toISOString(),
        },
        { seq: 2, role: "assistant", kind: "text", text: s.reply, at: new Date().toISOString() },
      ],
    });
}
send({
  type: "agent-limits",
  limits: {
    codex: {
      primary: {
        usedPercent: 24,
        windowMinutes: 300,
        resetsAt: new Date(Date.now() + 10800000).toISOString(),
      },
      secondary: {
        usedPercent: 38,
        windowMinutes: 10080,
        resetsAt: new Date(Date.now() + 259200000).toISOString(),
      },
      planType: "pro",
      observedAt: new Date().toISOString(),
    },
  },
});
writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
console.log("Demo playback ready: 3 simulated sessions. No commands or agents execute.");
const timer = setInterval(() => send({ type: "ping" }), 15000);
const close = () => {
  clearInterval(timer);
  for (const terminalId of sessions.keys()) send({ type: "exit", terminalId, exitCode: 0 });
  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, 250);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
