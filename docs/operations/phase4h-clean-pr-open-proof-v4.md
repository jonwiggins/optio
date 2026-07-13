# Phase 4H — Clean PR-Open Proof v4

## Purpose

Prove that live Optio, after the Phase 4G runtime fix, transitions a real
PR task to `pr_opened` with no stale `errorMessage` or `resultSummary`
carried over from earlier states, while running host-Claude with
reauthenticated credentials and no token env injection into the agent pod.

## Proof criteria

1. The task reaches `pr_opened` via `taskService.transitionTask()` on a
   live Optio deployment (no manual state edits).
2. At `pr_opened`, the task row has `errorMessage = null` and
   `resultSummary` reflecting only the current run.
3. The agent pod environment contains no injected auth token variables;
   host-Claude auth comes from the reauthenticated host credential.
4. Shell-sensitive text in the task prompt stayed inert end to end:
   - Markdown backticks: `echo should-not-run` (never executed)
   - Dollar var: $HOME (not expanded)
   - Glob-like branch text: optio/task-* (not globbed)
   - Literal newlines remained inside the prompt, never split into
     separate shell commands.

## Result expected from live Optio after the Phase 4G runtime fix

The PR watcher detects the opened PR on its next poll cycle and the task
transitions `running → pr_opened` cleanly. The task detail view shows no
residual error banner, the state event log records the transition once,
and the run's `resultSummary` describes this PR only. No
`should-not-run` command appears in agent logs, confirming prompt
quoting is safe under the Phase 4G runtime fix.
