/**
 * What the fake runtime plays, in one place for both ways of playing it:
 * fake.ts (the in-process `exec` session) and fake-agent.mjs (the detached
 * process of the run protocol). Plain JavaScript so the agent process needs
 * no loader; fake.ts imports it through fake-tape.d.mts.
 *
 * `planAgentRun()` turns an exec script, the prompt, and the container's env
 * into a plan: the init event, whether to hang, how long to sleep, then the
 * lines to write (events and raw lines) and the exit code. The directives
 * are the ones fake.ts documents; echo-stdin and the EOF wait are protocol
 * behaviors the agent process adds on top.
 */
import { randomUUID } from "node:crypto";

export const AGENT_EXEC_MARKER = "--output-format stream-json";
/** A Job's shell command (apps/api/src/services/command-run.ts). */
export const COMMAND_RUN_MARKER = 'bash -lc "$OPTIO_COMMAND"';
/** Markers of non-claude agent CLIs the fake cannot play — fail loudly. */
export const UNSUPPORTED_AGENT_MARKERS = [
  " codex ",
  " copilot ",
  " gemini ",
  " opencode ",
  " openclaw ",
];
/**
 * Cursor's stream-json events are claude-shaped (system:init / assistant /
 * result), so the fake plays cursor-agent execs with the standard tape. The
 * prompt arrives as a positional `"$OPTIO_PROMPT"` (no stdin priming), set by
 * the exec script's `export OPTIO_PROMPT='...'` line — extract it from there.
 */
export const CURSOR_EXEC_MARKER = "cursor-agent ";

/** The value an exec script exports for `name` (`export NAME='…'`), or null. */
export function extractScriptExport(script, name) {
  const m = script.match(new RegExp(`export ${name}='([^']*(?:'\\\\''[^']*)*)'`));
  return m ? m[1].replaceAll("'\\''", "'") : null;
}

/** The text of a stream-json user message line, or null for any other line. */
export function extractPromptText(line) {
  try {
    const msg = JSON.parse(line);
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

function directive(prompt, name) {
  return prompt.includes(`[[mock:${name}]]`);
}

export function directiveArg(prompt, name) {
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
export function collectDirectiveHaystack(script, prompt) {
  const parts = [prompt];
  const decodeOnce = (s) => {
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

/** The lines of a command run (`bash -lc "$OPTIO_COMMAND"`): raw output, then the status line. */
export function planCommandRun(script) {
  const fail = directive(script, "fail");
  const exitCode = fail ? 1 : 0;
  if (directive(script, "silent")) return { lines: [], exitCode, exitMarker: false };
  return {
    lines: [
      { raw: "[optio] Running command..." },
      { raw: "fake command output" },
      { raw: `[optio:exit] ${exitCode}` },
    ],
    exitCode,
    exitMarker: script.includes("__OPTIO_RUN_EXIT__:"),
  };
}

/**
 * The plan for an agent run.
 *
 *   { kind: "silent" }                        → nothing at all, exit 0
 *   { kind: "play", init, hang, sleepMs,
 *     lines: Array<{ event } | { raw }>,
 *     exitCode, echoStdin }
 *
 * `prNumber` names the PR `[[mock:pr]]` opens; `sessionId` is new when not given.
 */
export function planAgentRun({ script, prompt, specEnv = {}, prNumber = 1, sessionId }) {
  const haystack = collectDirectiveHaystack(script, prompt);
  const sid = sessionId ?? randomUUID();
  if (directive(haystack, "silent")) return { kind: "silent", sessionId: sid };

  const init = { type: "system", subtype: "init", session_id: sid, model: "fake-model", tools: [] };
  const hang = directive(haystack, "hang");
  const sleepMs = Number(directiveArg(haystack, "sleep") ?? 0);
  // [[mock:ticks:N]] or [[mock:ticks:N:MS]] → N assistant text events
  // `tick 1`…`tick N`, MS apart (default 100), after init: a run that is
  // busy for a while with numbered lines, so a consumer that changed hands
  // mid-run can prove it stored each exactly once.
  const [tickCount, tickMs] = (directiveArg(haystack, "ticks") ?? "0").split(":").map(Number);
  const ticks = { count: tickCount || 0, everyMs: Number.isFinite(tickMs) ? tickMs : 100 };
  // [[mock:mark:N:TEXT]] → an assistant text event `TEXT` right after tick N:
  // a line of the test's choosing in the middle of the run.
  const markArg = directiveArg(haystack, "mark");
  const markAt = markArg ? Number(markArg.split(":")[0]) : NaN;
  const mark = Number.isInteger(markAt)
    ? { at: markAt, text: markArg.slice(markArg.indexOf(":") + 1) }
    : null;
  const lines = [];
  const event = (e) => lines.push({ event: e });
  const raw = (l) => lines.push({ raw: l });

  event({
    type: "assistant",
    session_id: sid,
    message: {
      model: "fake-model",
      usage: { input_tokens: 100, output_tokens: 25 },
      content: [{ type: "text", text: `Mock agent handled: ${prompt.slice(0, 120)}` }],
    },
  });

  for (const m of haystack.matchAll(/\[\[mock:env:([A-Z0-9_]+)\]\]/g)) {
    const value = extractScriptExport(script, m[1]) ?? specEnv[m[1]] ?? "<unset>";
    raw(`env ${m[1]}=${value}`);
  }

  // [[mock:file:PATH]] → the setup file the exec script would write, as
  // `file PATH=<content>`; `<missing>` when the script carries no such file.
  for (const m of haystack.matchAll(/\[\[mock:file:([^\]]+)\]\]/g)) {
    const blob = extractScriptExport(script, "OPTIO_SETUP_FILES") ?? specEnv.OPTIO_SETUP_FILES;
    let content = "<missing>";
    if (blob) {
      try {
        const files = JSON.parse(Buffer.from(blob, "base64").toString("utf8"));
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
    raw(`file ${m[1]}=${JSON.stringify(content)}`);
  }

  // [[mock:script:TEXT]] → whether the exec script carries TEXT — outside
  // the prompt's own export line, which carries the directive itself.
  const scriptSansPrompt = script.replace(/export OPTIO_PROMPT='[^']*(?:'\\''[^']*)*'/, "");
  for (const m of haystack.matchAll(/\[\[mock:script:([^\]]+)\]\]/g)) {
    raw(`script ${m[1]}=${scriptSansPrompt.includes(m[1]) ? "present" : "absent"}`);
  }

  const repoUrl = (specEnv.OPTIO_REPO_URL ?? "https://github.com/mock/repo").replace(/\.git$/, "");
  const toolCall = (id, command, output) => {
    event({
      type: "assistant",
      session_id: sid,
      message: {
        model: "fake-model",
        content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
      },
    });
    event({
      type: "user",
      session_id: sid,
      message: { content: [{ type: "tool_result", tool_use_id: id, content: output }] },
    });
  };

  if (directive(haystack, "pr-mention")) {
    const mentioned = `${repoUrl}/pull/9999`;
    event({
      type: "assistant",
      session_id: sid,
      message: {
        model: "fake-model",
        content: [{ type: "text", text: `This is similar to ${mentioned} (see #9999).` }],
      },
    });
    toolCall(`toolu_view_${randomUUID().slice(0, 8)}`, "gh pr view 9999", `url: ${mentioned}`);
  }

  if (directive(haystack, "pr")) {
    const prUrl = `${repoUrl}/pull/${prNumber}`;
    toolCall(
      `toolu_create_${randomUUID().slice(0, 8)}`,
      "git push -u origin HEAD && gh pr create --fill",
      `${prUrl}\n`,
    );
    raw(`Opened pull request: ${prUrl}`);
  }

  const isError = directive(haystack, "fail");
  const cost = Number(directiveArg(haystack, "cost") ?? 0.0123);
  event({
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    is_error: isError,
    result: isError ? "Mock agent failure" : "Mock agent success",
    total_cost_usd: cost,
    num_turns: 1,
    duration_ms: 5,
    session_id: sid,
  });

  return {
    kind: "play",
    sessionId: sid,
    init,
    hang,
    sleepMs,
    ticks,
    mark,
    lines,
    exitCode: isError ? 1 : 0,
    echoStdin: directive(haystack, "echo-stdin"),
  };
}

/** The error result the fake emits when no prompt ever arrived. */
export function noPromptResult(sessionId, timeoutMs) {
  return {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: `FakeContainerRuntime: no prompt arrived on stdin within ${timeoutMs}ms — prompt delivery is broken`,
    total_cost_usd: 0,
    num_turns: 0,
    duration_ms: timeoutMs,
    session_id: sessionId,
  };
}
