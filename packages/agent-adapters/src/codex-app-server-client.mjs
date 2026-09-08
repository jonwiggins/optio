#!/usr/bin/env node

import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

class JsonRpcClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandler = null;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", (event) => {
        reject(event.error ?? new Error(`Failed to connect to ${this.url}`));
      });
      ws.addEventListener("close", () => {
        const error = new Error("Codex app-server websocket closed");
        for (const pending of this.pending.values()) {
          pending.reject(error);
        }
        this.pending.clear();
      });
      ws.addEventListener("message", (event) => {
        this.handleMessage(event.data);
      });
    });
  }

  onNotification(handler) {
    this.notificationHandler = handler;
  }

  async request(method, params) {
    const id = String(this.nextId++);
    const payload = { jsonrpc: "2.0", id, method, params };
    this.ws.send(JSON.stringify(payload));
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async close() {
    if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) return;
    await new Promise((resolve) => {
      this.ws.addEventListener("close", () => resolve(), { once: true });
      this.ws.close();
    });
  }

  handleMessage(raw) {
    const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");

    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id && this.pending.has(String(message.id))) {
        const pending = this.pending.get(String(message.id));
        this.pending.delete(String(message.id));
        if (message.error) {
          pending.reject(new Error(JSON.stringify(message.error)));
        } else {
          pending.resolve(message.result);
        }
        continue;
      }
      if (message.method && this.notificationHandler) {
        this.notificationHandler(message.method, message.params ?? {});
      }
    }
  }
}

const prompt = process.env.OPTIO_PROMPT ?? "";

if (!prompt.trim()) {
  emit({ type: "error", message: "OPTIO_PROMPT is required for Codex app-server mode" });
  process.exit(1);
}

const requestedUrl = process.env.OPTIO_CODEX_APP_SERVER_URL ?? "";
const requestedHost = parseHostname(requestedUrl);
if (requestedHost && !isLoopbackHost(requestedHost)) {
  emit({
    type: "message",
    role: "system",
    content:
      `Ignoring remote Codex app-server URL ${requestedUrl}. ` +
      "Remote app-server endpoints cannot operate on pod-local Optio worktrees; " +
      "starting a pod-local daemon instead.",
  });
}

const port = await allocatePort();
const listenUrl = `ws://127.0.0.1:${port}`;
const connectUrl = `${listenUrl}/v1/connect`;
const readyUrl = `http://127.0.0.1:${port}/readyz`;

let daemon = null;
let daemonStderr = "";
let daemonStdout = "";
let cleaningUp = false;

process.on("SIGINT", () => void cleanup(130));
process.on("SIGTERM", () => void cleanup(143));

try {
  daemon = spawn("codex", ["app-server", "--listen", listenUrl], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  daemon.stdout?.on("data", (chunk) => {
    daemonStdout += chunk.toString();
  });
  daemon.stderr?.on("data", (chunk) => {
    daemonStderr += chunk.toString();
  });

  await waitForReady(readyUrl, daemon);

  const client = new JsonRpcClient(connectUrl);
  await client.connect();

  const init = await client.request("initialize", {
    clientInfo: { name: "optio-codex-app-server", version: "0.1.0" },
    capabilities: {},
  });

  emit({
    id: null,
    type: "message",
    role: "system",
    content:
      `Connected to Codex app-server (${listenUrl})` +
      (init?.codexHome ? ` using ${init.codexHome}` : ""),
  });

  const account = await client.request("account/read", { refreshToken: true });
  if (!account?.account) {
    emit({
      type: "error",
      message:
        "Codex app-server is not logged in for this pod. " +
        "Run `codex login` in the repo pod home directory or configure shared CODEX_AUTH_JSON in the setup wizard.",
    });
    await client.close();
    await cleanup(1);
    process.exit(1);
  }

  const threadResp = await client.request("thread/start", {
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  const threadId = threadResp?.thread?.id;
  if (!threadId) {
    throw new Error("Codex app-server did not return a thread id");
  }

  emit({
    id: threadId,
    type: "message",
    role: "system",
    content: `Started Codex thread ${threadId}`,
  });

  const terminal = new Promise((resolve) => {
    const streamedAgentItems = new Set();

    client.onNotification((method, params) => {
      switch (method) {
        case "item/agentMessage/delta":
          streamedAgentItems.add(params.itemId);
          emit({
            id: threadId,
            type: "message",
            role: "assistant",
            content: params.delta,
          });
          return;
        case "item/reasoning/textDelta":
        case "item/reasoning/summaryTextDelta":
          emit({
            id: threadId,
            type: "reasoning",
            content: params.delta,
          });
          return;
        case "item/commandExecution/outputDelta":
        case "item/fileChange/outputDelta":
          emit({
            id: threadId,
            type: "message",
            role: "system",
            content: params.delta,
          });
          return;
        case "item/completed":
          emitCompletedItem(params.item, threadId, streamedAgentItems);
          return;
        case "warning":
        case "configWarning":
        case "guardianWarning":
          emit({
            id: threadId,
            type: "message",
            role: "system",
            content: params.message ?? params.summary ?? JSON.stringify(params),
          });
          return;
        case "error": {
          const message = formatError(params.error);
          emit({
            id: threadId,
            type: "error",
            message,
          });
          if (isAuthError(params.error)) {
            resolve({ ok: false, exitCode: 1 });
          }
          return;
        }
        case "turn/completed":
          if (params.turn?.status === "completed") {
            resolve({ ok: true, exitCode: 0 });
          } else {
            const errorMessage = formatTurnError(params.turn?.error);
            if (errorMessage) {
              emit({ id: threadId, type: "error", message: errorMessage });
            }
            resolve({ ok: false, exitCode: 1 });
          }
          return;
        default:
          return;
      }
    });
  });

  await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt }],
  });

  const result = await terminal;
  await client.close();
  await cleanup(result.exitCode);
  process.exit(result.exitCode);
} catch (error) {
  emit({
    type: "error",
    message: error instanceof Error ? error.message : "Codex app-server execution failed",
  });
  await cleanup(1);
  process.exit(1);
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitCompletedItem(item, threadId, streamedAgentItems) {
  if (!item || typeof item !== "object") return;

  if (item.type === "agentMessage") {
    if (streamedAgentItems.has(item.id)) return;
    emit({
      id: threadId,
      type: "message",
      role: "assistant",
      content: item.text ?? "",
    });
    return;
  }

  if (item.type === "reasoning") {
    for (const part of item.summary ?? item.content ?? []) {
      if (typeof part === "string" && part.trim()) {
        emit({ id: threadId, type: "reasoning", content: part });
      }
    }
    return;
  }

  if (item.type === "commandExecution") {
    emit({
      id: threadId,
      type: "function_call",
      name: "shell",
      call_id: item.id,
      arguments: JSON.stringify({ command: item.command, cwd: item.cwd }),
    });
    if (item.aggregatedOutput) {
      emit({
        id: threadId,
        type: "function_call_output",
        call_id: item.id,
        output: item.aggregatedOutput,
      });
    }
    return;
  }

  if (item.type === "mcpToolCall") {
    emit({
      id: threadId,
      type: "function_call",
      name: item.tool,
      call_id: item.id,
      arguments: JSON.stringify(item.arguments ?? {}),
    });
    if (item.result != null) {
      emit({
        id: threadId,
        type: "function_call_output",
        call_id: item.id,
        output: typeof item.result === "string" ? item.result : JSON.stringify(item.result),
      });
    }
    return;
  }

  if (item.type === "functionCallOutput") {
    emit({
      id: threadId,
      type: "function_call_output",
      call_id: item.id,
      output: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
    });
  }
}

function formatError(error) {
  if (!error) return "Codex app-server reported an unknown error";
  if (typeof error.message === "string" && error.message.trim()) {
    if (typeof error.additionalDetails === "string" && error.additionalDetails.trim()) {
      return `${error.message} (${error.additionalDetails})`;
    }
    return error.message;
  }
  return JSON.stringify(error);
}

function formatTurnError(error) {
  if (!error || typeof error !== "object") return null;
  if (typeof error.message === "string" && error.message.trim()) return error.message;
  if (typeof error.reason === "string" && error.reason.trim()) return error.reason;
  return null;
}

function isAuthError(error) {
  const message = `${error?.message ?? ""} ${error?.additionalDetails ?? ""}`;
  const info = error?.codexErrorInfo;
  const httpStatus =
    info?.responseStreamDisconnected?.httpStatusCode ??
    info?.responseStreamConnectionFailed?.httpStatusCode ??
    info?.httpConnectionFailed?.httpStatusCode ??
    null;
  return httpStatus === 401 || /unauthorized|not logged in|authentication/i.test(message);
}

function parseHostname(value) {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

async function allocatePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate local app-server port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForReady(readyUrl, daemonProcess) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (daemonProcess.exitCode != null) {
      throw new Error(
        `Codex app-server exited before becoming ready: ` +
          `${collectDaemonOutput() || `exit ${daemonProcess.exitCode}`}`,
      );
    }

    try {
      const response = await fetch(readyUrl);
      if (response.ok) return;
    } catch {
      // Keep polling until the daemon is ready or times out.
    }

    await delay(200);
  }

  throw new Error(`Timed out waiting for Codex app-server readiness at ${readyUrl}`);
}

async function cleanup(exitCode) {
  if (cleaningUp) return;
  cleaningUp = true;

  if (!daemon) return;
  if (daemon.exitCode != null) return;

  daemon.kill("SIGTERM");
  const deadline = Date.now() + 5_000;
  while (daemon.exitCode == null && Date.now() < deadline) {
    await delay(100);
  }
  if (daemon.exitCode == null) {
    daemon.kill("SIGKILL");
  }

  if (exitCode !== 0 && daemonStderr.trim()) {
    emit({
      type: "message",
      role: "system",
      content: `Codex app-server stderr: ${truncate(daemonStderr.trim(), 1200)}`,
    });
  }
}

function collectDaemonOutput() {
  const combined = `${daemonStderr}\n${daemonStdout}`.trim();
  return combined ? truncate(combined, 1200) : null;
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}
