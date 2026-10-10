#!/usr/bin/env node
/**
 * The fake runtime's agent, as a process of its own (fake.ts `startRun`):
 * plays the scripted claude stream-json tape into the run directory's
 * `output.ndjson`, reads `stdin.ndjson` the way the real supervisor feeds an
 * agent, and writes `exit` when it ends. It is spawned detached, so it
 * outlives the API process that started it — which is what the run protocol
 * is for (docs/plans/scale-out.md §1).
 *
 *   node fake-agent.mjs <runDir>
 *
 * `tape.json` in the run directory carries what the parent knew at start:
 * the exec script (directives can hide in its base64 blobs), the container's
 * env, the first stdin prompt when one was given, and the timeouts. The
 * directives are the ones fake.ts documents, plus `[[mock:echo-stdin]]`,
 * which turns every later stdin line into an assistant text event — how a
 * test proves a mid-run message reached the agent.
 *
 * Every JSON event carries a monotonically increasing `seq`, so a consumer
 * that re-attached can prove its log rows are contiguous and never
 * duplicated. Like claude with `--input-format stream-json`, the agent waits
 * for the EOF sentinel after its result; a run that never sends one ends
 * with exit 97 and a line in stderr.log, loudly.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const runDir = process.argv[2];
if (!runDir) {
  process.stderr.write("usage: fake-agent.mjs <runDir>\n");
  process.exit(2);
}

const FILES = {
  output: "output.ndjson",
  stdin: "stdin.ndjson",
  stderr: "stderr.log",
  exit: "exit",
};
const STDIN_EOF_SENTINEL = "__OPTIO_STDIN_EOF__";

const tape = JSON.parse(readFileSync(join(runDir, "tape.json"), "utf8"));
const sessionId = tape.sessionId ?? randomUUID();

let seq = 0;
let finished = false;

function emit(event) {
  seq += 1;
  appendFileSync(join(runDir, FILES.output), JSON.stringify({ ...event, seq }) + "\n");
}
function emitRaw(line) {
  appendFileSync(join(runDir, FILES.output), line + "\n");
}
function note(msg) {
  appendFileSync(join(runDir, FILES.stderr), `[fake-agent] ${msg}\n`);
}
function finish(code) {
  if (finished) return;
  finished = true;
  writeFileSync(join(runDir, FILES.exit), `${code}\n`);
  process.exit(code);
}

// A SIGTERM ends the run the way the real supervisor's trap does (143); a
// SIGKILL leaves no exit file, and an attach reports the run lost.
process.on("SIGTERM", () => finish(143));
process.on("SIGINT", () => finish(130));
process.on("SIGHUP", () => finish(129));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── stdin: new complete lines of stdin.ndjson since the last read ──────────

let stdinOffset = 0;
let stdinPartial = "";
function readStdinLines() {
  const path = join(runDir, FILES.stdin);
  if (!existsSync(path)) return [];
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= stdinOffset) return [];
    const buf = Buffer.alloc(size - stdinOffset);
    readSync(fd, buf, 0, buf.length, stdinOffset);
    stdinOffset = size;
    const parts = (stdinPartial + buf.toString("utf8")).split("\n");
    stdinPartial = parts.pop() ?? "";
    return parts.filter((l) => l.length > 0);
  } finally {
    closeSync(fd);
  }
}

function extractPromptText(line) {
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

// ── directives ──────────────────────────────────────────────────────────────

function directive(prompt, name) {
  return prompt.includes(`[[mock:${name}]]`);
}
function directiveArg(prompt, name) {
  const m = prompt.match(new RegExp(`\\[\\[mock:${name}:([^\\]]+)\\]\\]`));
  return m ? m[1] : null;
}
function extractScriptExport(script, name) {
  const m = script.match(new RegExp(`export ${name}='([^']*(?:'\\\\''[^']*)*)'`));
  return m ? m[1].replaceAll("'\\''", "'") : null;
}
/** Directives can hide in the script's base64 blobs (a repo task's task file). */
function collectDirectiveHaystack(script, prompt) {
  const parts = [prompt];
  const decodeOnce = (s) => {
    try {
      const text = Buffer.from(s, "base64").toString("utf8");
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

// ── the tapes ───────────────────────────────────────────────────────────────

async function playCommand() {
  const script = tape.script ?? "";
  const fail = directive(script, "fail");
  if (!directive(script, "silent")) {
    emitRaw("[optio] Running command...");
    emitRaw("fake command output");
    emitRaw(`[optio:exit] ${fail ? 1 : 0}`);
  }
  finish(fail ? 1 : 0);
}

async function playAgent() {
  const script = tape.script ?? "";
  const specEnv = tape.specEnv ?? {};
  let echoStdin = false;
  let eofSeen = false;

  // Every stdin line after the prompt: the sentinel, or (with echo-stdin) a
  // message to acknowledge as an assistant event.
  const consumeStdin = (lines) => {
    for (const line of lines) {
      if (line === STDIN_EOF_SENTINEL) {
        eofSeen = true;
        continue;
      }
      if (echoStdin) {
        const text = extractPromptText(line) ?? line;
        emit({
          type: "assistant",
          session_id: sessionId,
          message: { model: "fake-model", content: [{ type: "text", text: `stdin: ${text}` }] },
        });
      }
    }
  };

  // The prompt: given at start, or the first user message on stdin.
  let prompt = tape.initialPrompt ?? null;
  if (prompt === null) {
    const deadline = Date.now() + (tape.promptTimeoutMs ?? 10_000);
    while (prompt === null) {
      for (const line of readStdinLines()) {
        const text = extractPromptText(line);
        if (text !== null && prompt === null) prompt = text;
        else consumeStdin([line]);
      }
      if (prompt !== null) break;
      if (Date.now() > deadline) {
        emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: `FakeContainerRuntime: no prompt arrived on stdin within ${tape.promptTimeoutMs ?? 10_000}ms — prompt delivery is broken`,
          total_cost_usd: 0,
          num_turns: 0,
          duration_ms: tape.promptTimeoutMs ?? 10_000,
          session_id: sessionId,
        });
        finish(1);
        return;
      }
      await sleep(50);
    }
  }

  const haystack = collectDirectiveHaystack(script, prompt);
  echoStdin = directive(haystack, "echo-stdin");

  if (directive(haystack, "silent")) {
    finish(0);
    return;
  }

  emit({ type: "system", subtype: "init", session_id: sessionId, model: "fake-model", tools: [] });

  if (directive(haystack, "hang")) {
    // Never finishes: only a kill ends it.
    for (;;) {
      consumeStdin(readStdinLines());
      await sleep(100);
    }
  }

  const sleepMs = Number(directiveArg(haystack, "sleep") ?? 0);
  if (sleepMs > 0) {
    const until = Date.now() + sleepMs;
    while (Date.now() < until) {
      consumeStdin(readStdinLines());
      await sleep(Math.min(50, until - Date.now()));
    }
  }

  emit({
    type: "assistant",
    session_id: sessionId,
    message: {
      model: "fake-model",
      usage: { input_tokens: 100, output_tokens: 25 },
      content: [{ type: "text", text: `Mock agent handled: ${prompt.slice(0, 120)}` }],
    },
  });

  for (const m of haystack.matchAll(/\[\[mock:env:([A-Z0-9_]+)\]\]/g)) {
    const value = extractScriptExport(script, m[1]) ?? specEnv[m[1]] ?? "<unset>";
    emitRaw(`env ${m[1]}=${value}`);
  }

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
    emitRaw(`file ${m[1]}=${JSON.stringify(content)}`);
  }

  const scriptSansPrompt = script.replace(/export OPTIO_PROMPT='[^']*(?:'\\''[^']*)*'/, "");
  for (const m of haystack.matchAll(/\[\[mock:script:([^\]]+)\]\]/g)) {
    emitRaw(`script ${m[1]}=${scriptSansPrompt.includes(m[1]) ? "present" : "absent"}`);
  }

  const repoUrl = (specEnv.OPTIO_REPO_URL ?? "https://github.com/mock/repo").replace(/\.git$/, "");
  const toolCall = (id, command, output) => {
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

  if (directive(haystack, "pr-mention")) {
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

  if (directive(haystack, "pr")) {
    const prUrl = `${repoUrl}/pull/${tape.prNumber ?? 1}`;
    toolCall(
      `toolu_create_${randomUUID().slice(0, 8)}`,
      "git push -u origin HEAD && gh pr create --fill",
      `${prUrl}\n`,
    );
    emitRaw(`Opened pull request: ${prUrl}`);
  }

  const isError = directive(haystack, "fail");
  const cost = Number(directiveArg(haystack, "cost") ?? 0.0123);
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

  // Like claude: the turn is over, but the process waits for stdin to close.
  const eofDeadline = Date.now() + (tape.eofTimeoutMs ?? 60_000);
  while (!eofSeen) {
    consumeStdin(readStdinLines());
    if (eofSeen) break;
    if (Date.now() > eofDeadline) {
      note(
        `no ${STDIN_EOF_SENTINEL} arrived within ${tape.eofTimeoutMs ?? 60_000}ms of the result — the worker never closed the agent's stdin`,
      );
      finish(97);
      return;
    }
    await sleep(50);
  }
  finish(isError ? 1 : 0);
}

(tape.kind === "command" ? playCommand() : playAgent()).catch((err) => {
  note(`crashed: ${err?.stack ?? err}`);
  finish(70);
});
