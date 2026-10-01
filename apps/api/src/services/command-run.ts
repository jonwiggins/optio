/**
 * A Job that runs a shell command instead of an agent — a terminal that exits,
 * in the work attributes' terms. In a pod the command runs from the run's
 * exec script with stderr folded into stdout, every line becomes a log line,
 * and the script's last line is the command's exit status (an exec stream
 * carries none of its own). On a machine the daemon runs it as a command
 * terminal, whose exit code settles the run (local-run-service).
 */
import type { AgentLogEntry, AgentResult } from "@optio/shared";

/** The prefix of the last line a command run prints: its exit status. */
export const COMMAND_EXIT_MARKER = "[optio:exit] ";

/**
 * Script lines that run `$OPTIO_COMMAND` and report how it exited — on a line
 * of its own even when the output doesn't end in a newline (`printf`,
 * `curl -s`), so it never gets glued onto the last line of output.
 */
export const COMMAND_SCRIPT: readonly string[] = [
  `echo "[optio] Running command..."`,
  `bash -lc "$OPTIO_COMMAND" 2>&1`,
  `optio_status=$?`,
  `printf '\\n${COMMAND_EXIT_MARKER}%d\\n' "$optio_status"`,
];

/** One line of a command's output: a log line, or the command's exit status. */
export function parseCommandLine(
  line: string,
  runId: string,
): { entries: AgentLogEntry[]; exitCode?: number } {
  // The exit status is printed after a newline of its own, so a command whose
  // output ends in one leaves a blank line behind; blank lines aren't logged.
  if (line.trim() === "") return { entries: [] };
  if (line.startsWith(COMMAND_EXIT_MARKER)) {
    const code = Number.parseInt(line.slice(COMMAND_EXIT_MARKER.length), 10);
    if (Number.isFinite(code)) return { entries: [], exitCode: code };
  }
  return {
    entries: [{ taskId: runId, timestamp: new Date().toISOString(), type: "text", content: line }],
  };
}

/** How a command run ended: its exit status, or none if the stream was cut. */
export function commandResult(exitCode: number | undefined): AgentResult {
  if (exitCode === undefined) {
    return {
      success: false,
      error: "The command ended without an exit status (the pod or its stream went away)",
    };
  }
  return exitCode === 0
    ? { success: true, summary: "Command exited 0" }
    : { success: false, error: `Command exited with status ${exitCode}` };
}
