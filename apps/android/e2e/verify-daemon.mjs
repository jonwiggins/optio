/**
 * End-to-end check of the isolated Optio Local test daemon. Run it through
 * `apps/android/scripts/test-daemon.sh verify [--port N] [--agent]`, which passes the paths.
 *
 *  1. The daemon's host is online in GET /api/local/hosts.
 *  2. A throwaway {kind:"shell"} terminal in the scratch dir: wait for `running`, attach to
 *     /ws/local/terminals/:id/stream (subprotocols optio-ws-v1 + optio-auth-<token>; binary frames are
 *     terminal bytes, text frames JSON control), type a command through the socket, wait for its
 *     output, then kill and delete the terminal.
 *  3. --agent: ONE headless Claude Code session (haiku) in the e2e-repo checkout: a real LLM call
 *     on this machine's own Claude login (~$0.01). GET /api/local/terminals/:id/transcript must
 *     hold the prompt and a reply. The terminal is kept, and its id recorded in seed.json under
 *     `daemon.transcriptTerminalId`, so the Android Transcript face has a real conversation.
 *
 * --token <PAT> authenticates REST and WebSockets against an auth-enabled test API (default "dev",
 * which any auth-disabled API accepts). Needs Node 22+ (global fetch and WebSocket). Exit code 0
 * when every step passed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function parseArgs(argv) {
  const opts = { port: 4961, agent: false, token: "dev" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") opts.agent = true;
    else if (a.startsWith("--"))
      opts[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  opts.port = Number(opts.port);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const BASE = `http://127.0.0.1:${opts.port}`;
const WS_BASE = `ws://127.0.0.1:${opts.port}`;

const say = (msg) => process.stdout.write(`${msg}\n`);
const step = (msg) => say(`• ${msg}`);
const ok = (msg) => say(`  ✓ ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${opts.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000}s: ${label}`);
    await sleep(500);
  }
}

const getTerminal = async (id) => (await api(`/api/local/terminals/${id}`)).terminal;

async function waitState(id, states, timeoutMs) {
  return waitFor(
    async () => {
      const t = await getTerminal(id);
      return states.includes(t.state) ? t : null;
    },
    timeoutMs,
    `terminal ${id} reaching ${states.join("|")}`,
  );
}

/** Attach to a terminal's stream; resolves with helpers once the socket is open. */
function openStream(terminalId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/local/terminals/${terminalId}/stream`, [
      "optio-ws-v1",
      `optio-auth-${opts.token}`,
    ]);
    ws.binaryType = "arraybuffer";
    const state = { bytes: 0, text: "", control: [] };
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        try {
          state.control.push(JSON.parse(ev.data));
        } catch {
          state.control.push({ raw: ev.data });
        }
      } else {
        const buf = Buffer.from(ev.data);
        state.bytes += buf.length;
        state.text += buf.toString("utf8");
      }
    });
    ws.addEventListener("open", () => resolve({ ws, state }));
    ws.addEventListener("error", () => reject(new Error("stream WebSocket error")));
    ws.addEventListener("close", (ev) => {
      if (ev.code >= 4000) reject(new Error(`stream closed ${ev.code} ${ev.reason}`));
    });
  });
}

async function findHost() {
  step("daemon host is online");
  const { hosts } = await api("/api/local/hosts");
  const host = hosts.find((h) => h.id === opts.hostId);
  if (!host)
    throw new Error(
      `host ${opts.hostId} not found (hosts: ${hosts.map((h) => h.name).join(", ")})`,
    );
  if (host.state !== "online") throw new Error(`host ${host.name} is ${host.state}`);
  ok(
    `${host.name} (${host.id}) online, ${host.dirs.length} dirs, claudeCredentials=${host.claudeCredentials}`,
  );
  return host;
}

async function verifyShell(host) {
  step("shell terminal round trip over the stream WebSocket");
  const { terminal } = await api("/api/local/terminals", {
    method: "POST",
    body: {
      hostId: host.id,
      dir: opts.scratch,
      title: "DevLab verify (shell)",
      spec: { kind: "shell" },
    },
  });
  ok(`created ${terminal.id} (${terminal.state})`);
  let stream;
  try {
    await waitState(terminal.id, ["running"], 30_000);
    ok("running");
    stream = await openStream(terminal.id);
    await waitFor(async () => stream.state.bytes > 0, 20_000, "first terminal bytes");
    ok(
      `received ${stream.state.bytes} bytes; control frames: ${stream.state.control.map((c) => c.type).join(", ") || "none"}`,
    );
    // The typed text contains $((6*7)); only an executed command prints 42.
    stream.ws.send(JSON.stringify({ type: "input", data: "echo devlab-$((6*7))-ok\r" }));
    await waitFor(async () => stream.state.text.includes("devlab-42-ok"), 20_000, "command output");
    ok("typed `echo devlab-$((6*7))-ok` through the socket and read back devlab-42-ok");
  } finally {
    stream?.ws.close();
    await api(`/api/local/terminals/${terminal.id}/kill`, { method: "POST", body: {} }).catch(
      () => {},
    );
    await waitState(terminal.id, ["exited", "error"], 20_000).catch(() => {});
    await api(`/api/local/terminals/${terminal.id}`, { method: "DELETE" });
    ok("killed and deleted");
  }
}

function claudeLoginPresent() {
  try {
    // Attributes only (no -w): proves the Keychain item exists without reading the secret.
    execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    return existsSync(join(dir, ".credentials.json"));
  }
}

function claudeOnLoginPath() {
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    return execFileSync(shell, ["-lc", "command -v claude"], {
      encoding: "utf8",
      timeout: 20_000,
    }).trim();
  } catch {
    return "";
  }
}

async function verifyAgent(host) {
  step("headless Claude Code session + transcript (real LLM call)");
  if (!claudeLoginPresent()) {
    say("  - skipped: no Claude Code login on this machine");
    return null;
  }
  const claude = claudeOnLoginPath();
  if (!claude) {
    say("  - skipped: `claude` is not on the login shell's PATH");
    return null;
  }
  ok(`claude at ${claude}; login present`);
  const prompt =
    "This is an automated check of Optio's transcript capture. Reply with one short sentence " +
    "confirming you received it. Do not use any tools.";
  const started = Date.now();
  const { terminal } = await api("/api/local/terminals", {
    method: "POST",
    body: {
      hostId: host.id,
      dir: opts.repoDir,
      title: "DevLab transcript check",
      spec: { kind: "agent", agent: "claude-code", mode: "headless", model: "haiku", prompt },
    },
  });
  ok(`created ${terminal.id}`);
  const done = await waitState(terminal.id, ["exited", "error"], 240_000);
  ok(
    `finished: state=${done.state} exitCode=${done.exitCode ?? "?"} after ${Math.round((Date.now() - started) / 1000)}s`,
  );
  const transcript = await waitFor(
    async () => {
      const t = await api(`/api/local/terminals/${terminal.id}/transcript`);
      return t.entries?.some((e) => e.role === "assistant" && e.kind === "text") ? t : null;
    },
    30_000,
    "an assistant reply in the transcript",
  );
  for (const e of transcript.entries) {
    say(
      `    [${e.seq}] ${e.role}/${e.kind}${e.toolName ? ` ${e.toolName}` : ""}: ${String(e.text).replace(/\s+/g, " ").slice(0, 140)}`,
    );
  }
  if (!transcript.entries.some((e) => e.role === "user"))
    throw new Error("transcript has no user entry");
  ok(`transcript: ${transcript.entries.length} entries, complete=${transcript.complete}`);
  return {
    terminalId: terminal.id,
    entries: transcript.entries.length,
    complete: transcript.complete,
  };
}

function recordResults(host, agentResult) {
  const summary = {
    hostId: host.id,
    hostName: host.name,
    dirs: host.dirs,
    verifiedAt: new Date().toISOString(),
    ...(agentResult ? { transcriptTerminalId: agentResult.terminalId } : {}),
  };
  if (!opts.runDir) return;
  const seedPath = join(opts.runDir, "seed.json");
  if (!existsSync(seedPath)) return;
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  seed.daemon = { ...(seed.daemon ?? {}), ...summary };
  writeFileSync(seedPath, JSON.stringify(seed, null, 2) + "\n");
  ok(`recorded under "daemon" in ${seedPath}`);
}

async function main() {
  if (typeof WebSocket === "undefined") throw new Error("Node 22+ is required (global WebSocket)");
  if (!opts.hostId) throw new Error("--host-id is required (test-daemon.sh passes it)");
  const host = await findHost();
  await verifyShell(host);
  const agentResult = opts.agent ? await verifyAgent(host) : null;
  recordResults(host, agentResult);
  say("daemon verification passed");
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
