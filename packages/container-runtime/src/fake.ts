/**
 * FakeContainerRuntime — a deterministic, in-memory ContainerRuntime for the
 * e2e test tier. Selected with OPTIO_RUNTIME=fake. No containers, no cluster:
 * "pods" are Map entries and agent runs are scripted NDJSON responses.
 *
 * How it plays an agent: the task/workflow/persistent-agent workers exec a
 * bash script whose agent line is `claude ... --input-format stream-json
 * --output-format stream-json`, then write the rendered prompt to stdin as a
 * stream-json user message. This runtime never runs the script; it detects
 * agent execs by that flag, reads the prompt off stdin, and answers with the
 * exact NDJSON event stream `parseClaudeEvent` expects: a `system:init` event
 * (carrying the session id), optional content, and a terminal `result` event.
 * Everything downstream — log persistence, cost tracking, state transitions,
 * PR detection, reconciler behavior — is the real production pipeline.
 *
 * The prompt controls the scripted behavior via directives:
 *
 *   (none)               → successful run: init + assistant text + result
 *   [[mock:pr]]          → also print a PR URL for the pod's repo
 *                          (OPTIO_REPO_URL) so repo tasks reach PR_OPENED
 *   [[mock:fail]]        → result with is_error=true → run fails
 *   [[mock:silent]]      → no events at all → no session id → `no_output`
 *   [[mock:sleep:MS]]    → wait MS before emitting the result (stall testing)
 *   [[mock:hang]]        → emit init, then never finish — reaped only by
 *                          close(), destroy(), or a kill-style utility exec
 *   [[mock:cost:X]]      → report X as total_cost_usd (default 0.0123)
 *
 * Non-agent execs (worktree cleanup, orphan kills, health probes) return an
 * immediately-ending empty session; kill-style scripts (pkill/kill) also
 * terminate the container's live agent sessions, mirroring orphan cleanup in
 * a real pod. Interactive-session chat execs (`claude -p '<prompt>' ...`)
 * are played from the inline prompt. If no prompt ever arrives, the run
 * fails loudly — silent success would mask broken prompt delivery.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import type { ContainerSpec, ContainerHandle, ContainerStatus, ExecSession } from "@optio/shared";
import type { ContainerRuntime, ExecOptions, LogOptions } from "./types.js";

const AGENT_EXEC_MARKER = "--output-format stream-json";
/** Markers of non-claude agent CLIs the fake cannot play — fail loudly. */
const UNSUPPORTED_AGENT_MARKERS = [" codex ", " copilot ", " gemini ", " opencode ", " openclaw "];
/**
 * Cursor's stream-json events are claude-shaped (system:init / assistant /
 * result), so the fake plays cursor-agent execs with the standard tape. The
 * prompt arrives as a positional `"$OPTIO_PROMPT"` (no stdin priming), set by
 * the exec script's `export OPTIO_PROMPT='...'` line — extract it from there.
 */
const CURSOR_EXEC_MARKER = "cursor-agent ";

/** Pull the OPTIO_PROMPT value out of the exec script's single-quoted export. */
function extractScriptPrompt(script: string): string {
  const m = script.match(/export OPTIO_PROMPT='([^']*(?:'\\''[^']*)*)'/);
  return m ? m[1].replaceAll("'\\''", "'") : "";
}
/**
 * How long exec waits for a prompt on stdin before failing the run — a
 * missing prompt means the worker's stdin delivery broke, which must surface
 * loudly rather than play a success tape. Overridable for unit tests.
 */
const PROMPT_TIMEOUT_MS = Number(process.env.OPTIO_FAKE_PROMPT_TIMEOUT_MS ?? 10_000);

interface FakeContainer {
  spec: ContainerSpec;
  createdAt: Date;
}

function extractPromptText(line: string): string | null {
  try {
    const msg = JSON.parse(line) as {
      type?: string;
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    if (msg.type !== "user") return null;
    const blocks = msg.message?.content ?? [];
    return blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  } catch {
    return null;
  }
}

function directive(prompt: string, name: string): boolean {
  return prompt.includes(`[[mock:${name}]]`);
}

function directiveArg(prompt: string, name: string): string | null {
  const m = prompt.match(new RegExp(`\\[\\[mock:${name}:([^\\]]+)\\]\\]`));
  return m ? m[1] : null;
}

/**
 * Directives can hide inside the exec script rather than the stdin prompt:
 * for REPO tasks the stdin prompt is the rendered coding template (the raw
 * task prompt only exists in the task FILE, which travels base64-encoded in
 * the script — env blob → OPTIO_SETUP_FILES → file content). Decode base64
 * runs up to two levels deep and search everything.
 */
function collectDirectiveHaystack(script: string, prompt: string): string {
  const parts = [prompt];
  const decodeOnce = (s: string): string | null => {
    try {
      const text = Buffer.from(s, "base64").toString("utf8");
      // Reject binary-looking decodes.
      return /[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 200)) ? null : text;
    } catch {
      return null;
    }
  };
  for (const run of script.match(/[A-Za-z0-9+/=]{80,}/g) ?? []) {
    const level1 = decodeOnce(run);
    if (!level1) continue;
    parts.push(level1);
    for (const nested of level1.match(/[A-Za-z0-9+/=]{80,}/g) ?? []) {
      const level2 = decodeOnce(nested);
      if (level2) parts.push(level2);
    }
  }
  return parts.join("\n");
}

export class FakeContainerRuntime implements ContainerRuntime {
  private containers = new Map<string, FakeContainer>();
  /** Live agent-session closers per container — for kill/destroy emulation. */
  private sessionClosers = new Map<string, Set<() => void>>();
  private prCounter = 0;

  async create(spec: ContainerSpec): Promise<ContainerHandle> {
    const id = `fake-${randomBytes(6).toString("hex")}`;
    const name = spec.name ?? id;
    this.containers.set(id, { spec, createdAt: new Date() });
    return { id, name };
  }

  async status(handle: ContainerHandle): Promise<ContainerStatus> {
    const c = this.containers.get(handle.id);
    if (!c) return { state: "unknown", reason: "fake container not found" };
    return { state: "running", startedAt: c.createdAt };
  }

  async *logs(_handle: ContainerHandle, _opts?: LogOptions): AsyncIterable<string> {
    return;
  }

  async exec(
    handle: ContainerHandle,
    command: string[],
    _opts?: ExecOptions,
  ): Promise<ExecSession> {
    const script = command.join(" ");
    if (!script.includes(AGENT_EXEC_MARKER)) {
      if (UNSUPPORTED_AGENT_MARKERS.some((m) => script.includes(m))) {
        // A non-claude agent invocation would otherwise get an empty utility
        // session and be misclassified downstream — fail loudly instead.
        throw new Error(
          "FakeContainerRuntime only plays claude-code stream-json agents; " +
            "use agentType/agentRuntime claude-code in e2e tests",
        );
      }
      // Utility shell execs. Scripts that kill agent processes (orphan
      // cleanup, stall recovery) must terminate live agent sessions so
      // hanging runs are actually reapable, mirroring the real pod.
      if (/\bpkill\b|\bkill\b/.test(script)) {
        for (const closeSession of this.sessionClosers.get(handle.id) ?? []) closeSession();
      }
      return this.utilitySession();
    }
    return this.agentSession(handle.id, script);
  }

  async destroy(handle: ContainerHandle): Promise<void> {
    for (const closeSession of this.sessionClosers.get(handle.id) ?? []) closeSession();
    this.sessionClosers.delete(handle.id);
    this.containers.delete(handle.id);
  }

  async ping(): Promise<boolean> {
    return true;
  }

  /** Empty session for non-agent shell execs: ends immediately, exit-ok. */
  private utilitySession(): ExecSession {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new Writable({ write: (_c, _e, cb) => cb() });
    stdout.end();
    stderr.end();
    return {
      stdin,
      stdout,
      stderr,
      resize: () => {},
      close: () => {},
    };
  }

  private agentSession(containerId: string, script: string): ExecSession {
    const spec = this.containers.get(containerId)?.spec;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const sessionId = randomUUID();
    let closed = false;
    let promptHandled = false;
    let stdinBuf = "";
    let sleepTimer: ReturnType<typeof setTimeout> | undefined;

    const emit = (event: Record<string, unknown>) => {
      if (!closed) stdout.write(JSON.stringify(event) + "\n");
    };
    const emitRaw = (line: string) => {
      if (!closed) stdout.write(line + "\n");
    };
    const finish = () => {
      if (closed) return;
      stdout.end();
      stderr.end();
    };

    const run = async (echoPrompt: string) => {
      // Directives may live in the stdin prompt (standalone jobs, persistent
      // agents) or buried in the exec script's task file (repo tasks).
      const prompt = collectDirectiveHaystack(script, echoPrompt);
      if (directive(prompt, "silent")) {
        finish();
        return;
      }

      emit({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        model: "fake-model",
        tools: [],
      });

      if (directive(prompt, "hang")) {
        return; // stream stays open until close()
      }

      const sleepMs = Number(directiveArg(prompt, "sleep") ?? 0);
      if (sleepMs > 0) {
        await new Promise<void>((r) => {
          sleepTimer = setTimeout(r, sleepMs);
          sleepTimer.unref?.();
        });
        if (closed) return;
      }

      emit({
        type: "assistant",
        session_id: sessionId,
        message: {
          model: "fake-model",
          usage: { input_tokens: 100, output_tokens: 25 },
          content: [{ type: "text", text: `Mock agent handled: ${echoPrompt.slice(0, 120)}` }],
        },
      });

      if (directive(prompt, "pr")) {
        const repoUrl = (spec?.env?.OPTIO_REPO_URL ?? "https://github.com/mock/repo").replace(
          /\.git$/,
          "",
        );
        this.prCounter += 1;
        emitRaw(`Opened pull request: ${repoUrl}/pull/${this.prCounter}`);
      }

      const isError = directive(prompt, "fail");
      const cost = Number(directiveArg(prompt, "cost") ?? 0.0123);
      emit({
        type: "result",
        subtype: isError ? "error_during_execution" : "success",
        is_error: isError,
        result: isError ? "Mock agent failure" : "Mock agent success",
        total_cost_usd: cost,
        num_turns: 1,
        duration_ms: 5,
        session_id: sessionId,
      });
      finish();
    };

    const handlePrompt = (prompt: string) => {
      if (promptHandled) return;
      promptHandled = true;
      clearTimeout(promptTimer);
      void run(prompt);
    };

    // Interactive-session chat execs pass the prompt inline (`claude -p
    // '<prompt>' ...`) instead of over stdin — play it immediately.
    const inlinePrompt = script.match(/\bclaude\s+-p\s+'([^']*)'/);

    // The workers write the prompt right after exec resolves. If none ever
    // arrives, stdin delivery broke — fail the run loudly instead of playing
    // a success tape that would mask the regression.
    const promptTimer = setTimeout(() => {
      if (promptHandled) return;
      promptHandled = true;
      emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: `FakeContainerRuntime: no prompt arrived on stdin within ${PROMPT_TIMEOUT_MS}ms — prompt delivery is broken`,
        total_cost_usd: 0,
        num_turns: 0,
        duration_ms: PROMPT_TIMEOUT_MS,
        session_id: sessionId,
      });
      finish();
    }, PROMPT_TIMEOUT_MS);
    promptTimer.unref?.();

    const stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        stdinBuf += chunk.toString();
        let idx: number;
        while ((idx = stdinBuf.indexOf("\n")) >= 0) {
          const line = stdinBuf.slice(0, idx);
          stdinBuf = stdinBuf.slice(idx + 1);
          const prompt = extractPromptText(line);
          if (prompt !== null) handlePrompt(prompt);
        }
        cb();
      },
    });

    const close = () => {
      if (closed) {
        return;
      }
      clearTimeout(promptTimer);
      if (sleepTimer) clearTimeout(sleepTimer);
      // Mirror the k8s exec contract: a severed session ENDS the streams
      // (consumers see a normal end-of-stream), it does not error them.
      stdout.end();
      stderr.end();
      closed = true;
      this.sessionClosers.get(containerId)?.delete(close);
    };

    let closers = this.sessionClosers.get(containerId);
    if (!closers) {
      closers = new Set();
      this.sessionClosers.set(containerId, closers);
    }
    closers.add(close);

    if (inlinePrompt) handlePrompt(inlinePrompt[1]);
    // Cursor delivers the prompt as a positional env-var reference, not stdin.
    if (script.includes(CURSOR_EXEC_MARKER)) {
      handlePrompt(extractScriptPrompt(script) || (spec?.env?.OPTIO_PROMPT ?? ""));
    }

    return {
      stdin,
      stdout,
      stderr,
      resize: () => {},
      close,
    };
  }
}
