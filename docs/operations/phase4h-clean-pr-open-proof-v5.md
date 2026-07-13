# Phase 4H — Clean PR-Open Proof v5

## Purpose

Prove that live Optio transitions a real Repo Task to `pr_opened` cleanly after the
prompt shell-quoting runtime fix: no stale `errorMessage`, no stale `resultSummary`,
and no shell interpretation of prompt text along the way.

## Proof criteria

1. The task reaches `pr_opened` via `taskService.transitionTask()` with a valid
   state-machine transition (no `InvalidTransitionError`).
2. `errorMessage` and `resultSummary` on the task row are cleared/empty at
   `pr_opened` — no values left over from earlier attempts.
3. Shell-sensitive prompt text is delivered to the agent verbatim and stays inert:
   - Markdown backticks: `echo should-not-run` (the command is never executed)
   - Dollar var: $HOME (not expanded to a path)
   - Glob-like branch text: optio/task-* (not expanded against the filesystem)
   - Literal newlines remain inside the prompt and never split into separate
     shell commands.
4. The agent's PR is opened by the agent itself and is picked up by the PR watcher.

## Expected result from live Optio

After the prompt shell-quoting runtime fix, a task created with the prompt above
runs to completion: the agent receives the prompt byte-for-byte, commits this
docs-only change, and opens a PR. The task row shows `status = pr_opened` with
empty `errorMessage` and `resultSummary`, and no `should-not-run` output, `$HOME`
expansion, or glob expansion appears anywhere in the run logs.
