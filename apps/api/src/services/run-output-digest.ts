/**
 * What a run's output says about how it ended, read line by line as it
 * streams (docs/plans/scale-out.md §1): the adapter's result (cost, tokens,
 * summary, error), the exit code the output implies, and an auth failure.
 * A worker never holds a run's whole output; an instance that attaches to a
 * run later rebuilds the digest from byte 0 by replaying the output file.
 */
import { getAdapter, type AgentResultParser } from "@optio/agent-adapters";
import type { AgentResult } from "@optio/shared";
import { detectAuthFailureInLine, type AuthFailureDetection } from "./auth-failure-detector.js";

export interface RunOutputVerdict {
  result: AgentResult;
  /** The exit code the result was read with (see `RunOutputDigest.finish`). */
  exitCode: number;
  /** The first auth failure the output carries, if any. */
  auth: AuthFailureDetection;
}

export class RunOutputDigest {
  private readonly parser: AgentResultParser;
  private readonly inference: ExitCodeInference;
  private auth: AuthFailureDetection = { matched: false };

  constructor(agentType: string) {
    this.parser = getAdapter(agentType).createResultParser();
    this.inference = new ExitCodeInference(agentType);
  }

  /** One line of the agent's output, in order, without its newline. */
  push(line: string): void {
    this.parser.push(line);
    this.inference.push(line);
    if (!this.auth.matched) this.auth = detectAuthFailureInLine(line);
  }

  /**
   * The verdict once the agent exited with `exitCode`. With `inferExitCode`
   * (tasks and review runs) the output decides, as those workers always
   * read it: for Claude (and Cursor, which emits Claude's result event) a
   * `result` event seen is authoritative (`is_error` decides, whatever the
   * process exit), then a fatal raw line, and only an output that says
   * neither leaves it to the process's exit code; every other agent's code
   * is its failure signals alone (1 or 0) — its process's exit code is
   * ignored, as it was before the run protocol. Without `inferExitCode`
   * (Job runs, agent turns) the process's exit code is the code, as it
   * always was.
   */
  finish(exitCode: number, opts: { inferExitCode?: boolean } = {}): RunOutputVerdict {
    const code = opts.inferExitCode ? this.inference.resolve(exitCode) : exitCode;
    return { result: this.parser.finish(code), exitCode: code, auth: this.auth };
  }
}

/**
 * The exit code an agent's output implies, from agent-specific error
 * patterns, read line by line (no pattern spans a line).
 */
export class ExitCodeInference {
  private readonly kind: string;
  private firstResult: number | null = null;
  private flagged = false;

  constructor(agentType: string) {
    this.kind =
      agentType in ERROR_SIGNALS || agentType === "cursor" || agentType === "pi"
        ? agentType
        : "claude-code";
  }

  push(line: string): void {
    if (this.kind === "pi") return;
    if (this.kind === "claude-code") {
      // The NDJSON result event is the authoritative source for Claude's
      // exit status. Raw string matching on JSON lines produces false
      // positives — "fatal:" in git output Claude ran and handled.
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: { type?: unknown; is_error?: unknown } | null = null;
      try {
        event = JSON.parse(trimmed);
      } catch {
        // A raw output line: a fatal error, if no result event follows.
        if (trimmed.includes("fatal:") || trimmed.includes("Error: authentication_failed")) {
          this.flagged = true;
        }
        return;
      }
      if (this.firstResult === null && event?.type === "result") {
        this.firstResult = event.is_error ? 1 : 0;
      }
      return;
    }
    if (this.kind === "cursor") {
      // Cursor emits a Claude-style terminal result event — use it when present.
      if (this.firstResult === null) {
        try {
          const event = JSON.parse(line);
          if (event?.type === "result") this.firstResult = event.is_error ? 1 : 0;
        } catch {
          // Not JSON — headless failures print plain text
        }
      }
      if (!this.flagged && CURSOR_FALLBACK(line)) this.flagged = true;
      return;
    }
    if (!this.flagged && ERROR_SIGNALS[this.kind](line)) this.flagged = true;
  }

  /** The code the output alone implies (no result event and no failure signal: 0). */
  value(): number {
    if (this.kind === "claude-code" || this.kind === "cursor") {
      return this.firstResult ?? (this.flagged ? 1 : 0);
    }
    return this.flagged ? 1 : 0;
  }

  /**
   * The run's exit code, the output read with the process's own. Claude and
   * Cursor: a result event seen decides (its `is_error`); else a failure
   * signal is 1; else the process's exit code. Every other agent: its
   * failure signals alone — the exit code is not consulted (the old
   * whole-output `inferExitCode` of the task and review workers).
   */
  resolve(processExitCode: number): number {
    if (this.kind === "pi") return processExitCode;
    if (this.kind !== "claude-code" && this.kind !== "cursor") return this.flagged ? 1 : 0;
    if (this.firstResult !== null) return this.firstResult;
    if (this.flagged) return 1;
    return processExitCode;
  }
}

const hasErrorEvent = (line: string) =>
  line.includes('"type":"error"') || line.includes('"type": "error"');
const hasApiErrorEnvelope = (line: string) => /"error"\s*:\s*\{\s*"message"/.test(line);
const hasModelError = (line: string) =>
  /model_not_found|model.*not found|does not exist.*model/i.test(line);
const hasFatalError = (line: string) =>
  line.includes("fatal:") || line.includes("Error: authentication_failed");

/** Per agent: does this line say the run failed, whatever its exit status? */
const ERROR_SIGNALS: Record<string, (line: string) => boolean> = {
  codex: (line) =>
    hasErrorEvent(line) ||
    hasApiErrorEnvelope(line) ||
    /OPENAI_API_KEY|invalid.*api.?key|unauthorized|authentication.*failed/i.test(line) ||
    /quota|insufficient_quota|billing/i.test(line) ||
    hasModelError(line) ||
    /content.?filter|content.?policy|safety.?system/i.test(line),
  copilot: (line) =>
    line.includes('"is_error":true') ||
    line.includes('"is_error": true') ||
    hasErrorEvent(line) ||
    /COPILOT_GITHUB_TOKEN|copilot.*auth|subscription.*required|unauthorized/i.test(line) ||
    hasFatalError(line),
  opencode: (line) =>
    hasErrorEvent(line) ||
    hasApiErrorEnvelope(line) ||
    /ANTHROPIC_API_KEY|OPENAI_API_KEY|GROQ_API_KEY|OPENCODE_API_KEY|invalid.*api.?key|unauthorized|authentication.*failed/i.test(
      line,
    ) ||
    hasModelError(line) ||
    hasFatalError(line),
  // Auth errors by error-descriptive patterns only (not bare env var names,
  // which could appear in diagnostic output and cause false positives).
  gemini: (line) =>
    hasErrorEvent(line) ||
    /api.?key.*(?:invalid|not valid|missing)|invalid.*api.?key|api_key_invalid|permission denied|unauthorized/i.test(
      line,
    ) ||
    /quota|resource.?exhausted|rate.?limit/i.test(line) ||
    /model.*not found|model_not_found|does not exist.*model/i.test(line) ||
    /turn.?limit|exit:?\s*53\b/i.test(line),
  openclaw: (line) =>
    hasErrorEvent(line) ||
    hasApiErrorEnvelope(line) ||
    /ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENCLAW_API_KEY|invalid.*api.?key|unauthorized|authentication.*failed/i.test(
      line,
    ) ||
    hasModelError(line) ||
    hasFatalError(line),
};

/** Cursor with no result event: headless failures print plain text to stderr. */
const CURSOR_FALLBACK = (line: string) =>
  /CURSOR_API_KEY|invalid.*api.?key|unauthorized|authentication.*failed|not.*logged.*in/i.test(
    line,
  ) ||
  /usage limit|quota|subscription.*required/i.test(line) ||
  /model.*not found|model_not_found|does not exist.*model/i.test(line) ||
  hasErrorEvent(line);

/** The exit code a whole output implies (`ExitCodeInference` fed every line). */
export function inferExitCode(agentType: string, logs: string): number {
  const inference = new ExitCodeInference(agentType);
  for (const line of logs.split("\n")) inference.push(line);
  return inference.value();
}
