#!/usr/bin/env node
/**
 * The fake runtime's agent, as a process of its own (fake.ts `startRun`):
 * plays the tape fake-tape.mjs plans into the run directory's
 * `output.ndjson`, reads `stdin.ndjson` the way the real supervisor feeds an
 * agent, and writes `exit` when it ends. It is spawned detached, so it
 * outlives the API process that started it — which is what the run protocol
 * is for (docs/plans/scale-out.md §1).
 *
 *   node fake-agent.mjs <runDir>
 *
 * `tape.json` in the run directory carries what the parent knew at start:
 * the exec script (directives can hide in its base64 blobs), the container's
 * env, the first stdin prompt when one was given, the PR number, and the
 * timeouts. Like the real supervisor, this process writes its own pid file
 * (`<pid> <starttime>`) only once its TERM handler is installed, so a
 * signal can never arrive before it; the parent waits for that file.
 *
 * Every JSON event carries a monotonically increasing `seq`, so a consumer
 * that re-attached can prove its log rows are contiguous and never
 * duplicated. Like claude with `--input-format stream-json`, the agent waits
 * for the EOF sentinel after its result; a run that never sends one ends
 * with exit 97 and a line in stderr.log, loudly. `[[mock:echo-stdin]]` turns
 * every later stdin line into an assistant text event.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { extractPromptText, noPromptResult, planAgentRun, planCommandRun } from "./fake-tape.mjs";

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
  pid: "pid",
};
const STDIN_EOF_SENTINEL = "__OPTIO_STDIN_EOF__";

const tape = JSON.parse(readFileSync(join(runDir, "tape.json"), "utf8"));

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
  // Through a temp file like the pid file: an attach that sees the exit file
  // must never read it half-written (an empty file reads as no exit code).
  writeFileSync(join(runDir, `${FILES.exit}.tmp`), `${code}\n`);
  renameSync(join(runDir, `${FILES.exit}.tmp`), join(runDir, FILES.exit));
  process.exit(code);
}

// A SIGTERM ends the run the way the real supervisor's trap does (143); a
// SIGKILL leaves no exit file, and an attach reports the run lost.
process.on("SIGTERM", () => finish(143));
process.on("SIGINT", () => finish(130));
process.on("SIGHUP", () => finish(129));

/** This process's identity beside its pid: its start time on Linux, a token elsewhere. */
export function processStartToken() {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return `t${process.hrtime.bigint().toString(36)}`;
  }
}

// Only now — handlers in place — does the parent get to know us.
writeFileSync(join(runDir, `${FILES.pid}.tmp`), `${process.pid} ${processStartToken()}\n`);
renameSync(join(runDir, `${FILES.pid}.tmp`), join(runDir, FILES.pid));

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

function writeLine(line) {
  if ("event" in line) emit(line.event);
  else emitRaw(line.raw);
}

async function playCommand() {
  const plan = planCommandRun(tape.script ?? "");
  for (const line of plan.lines) writeLine(line);
  finish(plan.exitCode);
}

async function playAgent() {
  const script = tape.script ?? "";
  const specEnv = tape.specEnv ?? {};
  let echoStdin = false;
  let eofSeen = false;
  let sessionId = tape.sessionId;

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
    const timeoutMs = tape.promptTimeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    while (prompt === null) {
      for (const line of readStdinLines()) {
        const text = extractPromptText(line);
        if (text !== null && prompt === null) prompt = text;
        else consumeStdin([line]);
      }
      if (prompt !== null) break;
      if (Date.now() > deadline) {
        emit(noPromptResult(sessionId, timeoutMs));
        finish(1);
        return;
      }
      await sleep(50);
    }
  }

  const plan = planAgentRun({ script, prompt, specEnv, prNumber: tape.prNumber, sessionId });
  sessionId = plan.sessionId;
  if (plan.kind === "silent") {
    finish(0);
    return;
  }
  echoStdin = plan.echoStdin;

  emit(plan.init);

  for (let i = 1; i <= (plan.ticks?.count ?? 0); i++) {
    consumeStdin(readStdinLines());
    emit({
      type: "assistant",
      session_id: sessionId,
      message: { model: "fake-model", content: [{ type: "text", text: `tick ${i}` }] },
    });
    if (plan.mark && plan.mark.at === i) {
      emit({
        type: "assistant",
        session_id: sessionId,
        message: { model: "fake-model", content: [{ type: "text", text: plan.mark.text }] },
      });
    }
    await sleep(plan.ticks.everyMs);
  }

  if (plan.hang) {
    // Never finishes: only a kill ends it.
    for (;;) {
      consumeStdin(readStdinLines());
      await sleep(100);
    }
  }

  if (plan.sleepMs > 0) {
    const until = Date.now() + plan.sleepMs;
    while (Date.now() < until) {
      consumeStdin(readStdinLines());
      await sleep(Math.min(50, until - Date.now()));
    }
  }

  for (const line of plan.lines) writeLine(line);

  // Like claude: the turn is over, but the process waits for stdin to close.
  const eofTimeoutMs = tape.eofTimeoutMs ?? 60_000;
  const eofDeadline = Date.now() + eofTimeoutMs;
  while (!eofSeen) {
    consumeStdin(readStdinLines());
    if (eofSeen) break;
    if (Date.now() > eofDeadline) {
      note(
        `no ${STDIN_EOF_SENTINEL} arrived within ${eofTimeoutMs}ms of the result — the worker never closed the agent's stdin`,
      );
      finish(97);
      return;
    }
    await sleep(50);
  }
  finish(plan.exitCode);
}

(tape.kind === "command" ? playCommand() : playAgent()).catch((err) => {
  note(`crashed: ${err?.stack ?? err}`);
  finish(70);
});
