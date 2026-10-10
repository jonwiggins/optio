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
 *   [[mock:pr]]          → open a PR for the pod's repo (OPTIO_REPO_URL):
 *                          a Bash `tool_use` running `gh pr create` and its
 *                          `tool_result` carrying the PR URL (what PR
 *                          detection adopts), then a raw `Opened pull
 *                          request: <url>` line — repo tasks reach PR_OPENED
 *   [[mock:pr-mention]]  → assistant text that only *mentions* another PR of
 *                          the repo (`<repo>/pull/9999`), plus a `gh pr view`
 *                          call printing it — must never be adopted
 *   [[mock:fail]]        → result with is_error=true → run fails
 *   [[mock:silent]]      → no events at all → no session id → `no_output`
 *   [[mock:sleep:MS]]    → wait MS before emitting the result (stall testing)
 *   [[mock:hang]]        → emit init, then never finish — reaped only by
 *                          close(), destroy(), or a kill-style utility exec
 *   [[mock:cost:X]]      → report X as total_cost_usd (default 0.0123)
 *   [[mock:env:NAME]]    → also print `env NAME=<value>` as the exec script
 *                          exports it (`<unset>` when it doesn't) — lets e2e
 *                          tests check what a run's agent was given
 *   [[mock:file:PATH]]   → also print `file PATH=<content as a JSON string>`
 *                          for a setup file the exec script would write
 *                          (`"<missing>"` when it carries none at that path);
 *                          a PATH starting with `*` matches a file whose
 *                          path ends with the rest (a per-run home's file)
 *   [[mock:script:TEXT]] → also print `script TEXT=present|absent`, whether
 *                          the exec script contains TEXT (a launch flag, a
 *                          cleanup line)
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
/** A Job's shell command (apps/api/src/services/command-run.ts). */
const COMMAND_RUN_MARKER = 'bash -lc "$OPTIO_COMMAND"';
/** Markers of non-claude agent CLIs the fake cannot play — fail loudly. */
const UNSUPPORTED_AGENT_MARKERS = [" codex ", " copilot ", " gemini ", " opencode ", " openclaw "];
/**
 * Cursor's stream-json events are claude-shaped (system:init / assistant /
 * result), so the fake plays cursor-agent execs with the standard tape. The
 * prompt arrives as a positional `"$OPTIO_PROMPT"` (no stdin priming), set by
 * the exec script's `export OPTIO_PROMPT='...'` line — extract it from there.
 */
const CURSOR_EXEC_MARKER = "cursor-agent ";

/** The value an exec script exports for `name` (`export NAME='…'`), or null. */
function extractScriptExport(script: string, name: string): string | null {
  const m = script.match(new RegExp(`export ${name}='([^']*(?:'\\\\''[^']*)*)'`));
  return m ? m[1].replaceAll("'\\''", "'") : null;
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
    if (script.includes(COMMAND_RUN_MARKER)) return this.commandSession(script);
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

  /**
   * A Job that runs a shell command (no agent): its output, then the exit
   * status line the real script prints. `[[mock:fail]]` in the command
   * exits 1; `[[mock:silent]]` cuts the stream before any status.
   */
  private commandSession(script: string): ExecSession {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new Writable({ write: (_c, _e, cb) => cb() });
    // The command travels in the script itself (`export OPTIO_COMMAND='…'`).
    setImmediate(() => {
      if (!directive(script, "silent")) {
        stdout.write("[optio] Running command...\n");
        stdout.write("fake command output\n");
        stdout.write(`[optio:exit] ${directive(script, "fail") ? 1 : 0}\n`);
        if (script.includes("__OPTIO_RUN_EXIT__:"))
          stdout.write(`__OPTIO_RUN_EXIT__:${directive(script, "fail") ? 1 : 0}\n`);
      }
      stdout.end();
      stderr.end();
    });
    return { stdin, stdout, stderr, resize: () => {}, close: () => stdout.end() };
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
    const finish = (exitCode?: number) => {
      if (closed) return;
      if (exitCode !== undefined) {
        if (script.includes("__OPTIO_RUN_EXIT__:")) emitRaw(`__OPTIO_RUN_EXIT__:${exitCode}`);
        if (script.includes("__OPTIO_CHAT_EXIT__:")) emitRaw(`__OPTIO_CHAT_EXIT__:${exitCode}`);
      }
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

      for (const m of prompt.matchAll(/\[\[mock:env:([A-Z0-9_]+)\]\]/g)) {
        const value = extractScriptExport(script, m[1]) ?? spec?.env?.[m[1]] ?? "<unset>";
        emitRaw(`env ${m[1]}=${value}`);
      }

      // [[mock:file:PATH]] → print a setup file the exec script would write
      // (`OPTIO_SETUP_FILES`), as `file PATH=<content>`; `<missing>` when the
      // script carries no such file.
      for (const m of prompt.matchAll(/\[\[mock:file:([^\]]+)\]\]/g)) {
        const blob =
          extractScriptExport(script, "OPTIO_SETUP_FILES") ?? spec?.env?.OPTIO_SETUP_FILES;
        let content = "<missing>";
        if (blob) {
          try {
            const files = JSON.parse(Buffer.from(blob, "base64").toString("utf8")) as Array<{
              path: string;
              content?: string;
              contentBase64?: string;
            }>;
            const want = m[1];
            const f = files.find((x) =>
              want.startsWith("*") ? x.path.endsWith(want.slice(1)) : x.path === want,
            );
            if (f) {
              content = f.contentBase64
                ? Buffer.from(f.contentBase64, "base64").toString("utf8")
                : (f.content ?? "");
            }
          } catch {
            content = "<undecodable>";
          }
        }
        // One line: the content as a JSON string literal (log lines are split on newlines).
        emitRaw(`file ${m[1]}=${JSON.stringify(content)}`);
      }

      // [[mock:script:TEXT]] → whether the exec script carries TEXT — outside
      // the prompt's own export line, which carries the directive itself.
      const scriptSansPrompt = script.replace(/export OPTIO_PROMPT='[^']*(?:'\\''[^']*)*'/, "");
      for (const m of prompt.matchAll(/\[\[mock:script:([^\]]+)\]\]/g)) {
        emitRaw(`script ${m[1]}=${scriptSansPrompt.includes(m[1]) ? "present" : "absent"}`);
      }

      const repoUrl = (spec?.env?.OPTIO_REPO_URL ?? "https://github.com/mock/repo").replace(
        /\.git$/,
        "",
      );
      const toolCall = (id: string, command: string, output: string) => {
        emit({
          type: "assistant",
          session_id: sessionId,
          message: {
            model: "fake-model",
            content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
          },
        });
        emit({
          type: "user",
          session_id: sessionId,
          message: { content: [{ type: "tool_result", tool_use_id: id, content: output }] },
        });
      };

      if (directive(prompt, "pr-mention")) {
        const mentioned = `${repoUrl}/pull/9999`;
        emit({
          type: "assistant",
          session_id: sessionId,
          message: {
            model: "fake-model",
            content: [{ type: "text", text: `This is similar to ${mentioned} (see #9999).` }],
          },
        });
        toolCall(`toolu_view_${randomUUID().slice(0, 8)}`, "gh pr view 9999", `url: ${mentioned}`);
      }

      if (directive(prompt, "pr")) {
        this.prCounter += 1;
        const prUrl = `${repoUrl}/pull/${this.prCounter}`;
        toolCall(
          `toolu_create_${randomUUID().slice(0, 8)}`,
          "git push -u origin HEAD && gh pr create --fill",
          `${prUrl}\n`,
        );
        emitRaw(`Opened pull request: ${prUrl}`);
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
      finish(isError ? 1 : 0);
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
      handlePrompt(extractScriptExport(script, "OPTIO_PROMPT") || (spec?.env?.OPTIO_PROMPT ?? ""));
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
