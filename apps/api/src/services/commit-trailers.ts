/**
 * Commits that point back to the person and the run (docs/ticket-round-trip.md
 * "Traceable merge requests and commits"): a `prepare-commit-msg` hook in
 * the repo pod ends every commit message with
 *
 *   Jira: PLAT-1                                  (work from a Jira ticket)
 *   Co-authored-by: Ada Lovelace <ada@example.com>
 *   Optio-Run: https://optio.example.com/work/<id>
 *   Optio-Team: Platform                          (a team's work)
 *
 * from the run's environment (OPTIO_JIRA_KEY, OPTIO_COMMIT_CO_AUTHOR,
 * OPTIO_RUN_URL, OPTIO_TEAM_NAME; work-traceability.ts in @optio/shared
 * builds them, services/work-traceability.ts looks them up). A hook rather
 * than the prompt alone: the agent can't forget it. The prompt still names
 * the trailers, for a repository whose own `core.hooksPath` (husky) keeps
 * the hook from running; `--if-exists addIfDifferent` keeps them from being
 * added twice.
 *
 * Installed by the task's setup in the pod (repo-pool-service.ts
 * `taskSetupLines`) into the repository's shared hooks directory, so it
 * needs nothing in the agent image and works with a site's own images. A
 * repository's own prepare-commit-msg is kept (renamed `.optio-chained`) and
 * runs first. Every task in the pod shares the hook; each run's environment
 * says what it adds, and a run without those variables (OPTIO_COMMIT_TRAILERS
 * = false) adds nothing. The commit's author stays Optio's bot identity.
 */

/** In the hook's text: how the setup knows a hook is Optio's own. */
export const COMMIT_HOOK_MARKER = "optio-commit-trailers";

/** The hook. POSIX sh; the message file is $1, as git passes it. */
export function prepareCommitMsgHook(): string {
  return `#!/bin/sh
# ${COMMIT_HOOK_MARKER}: Optio's prepare-commit-msg hook (apps/api/src/services/commit-trailers.ts).
# Ends the commit message with who asked for the work and the run that made it,
# from the run's environment. Rewritten at every run; the repository's own hook,
# if it had one, is prepare-commit-msg.optio-chained and runs first.
here=$(dirname "$0")
if [ -x "$here/prepare-commit-msg.optio-chained" ]; then
  "$here/prepare-commit-msg.optio-chained" "$@" || exit $?
fi
msg="$1"
[ -n "$msg" ] && [ -f "$msg" ] || exit 0
# An empty message (only comments) stays empty, so git still aborts the commit.
grep -Eqv '^[[:space:]]*(#.*)?$' "$msg" || exit 0
set --
[ -n "\${OPTIO_JIRA_KEY:-}" ] && set -- "$@" --trailer "Jira: \${OPTIO_JIRA_KEY}"
[ -n "\${OPTIO_COMMIT_CO_AUTHOR:-}" ] && set -- "$@" --trailer "Co-authored-by: \${OPTIO_COMMIT_CO_AUTHOR}"
[ -n "\${OPTIO_RUN_URL:-}" ] && set -- "$@" --trailer "Optio-Run: \${OPTIO_RUN_URL}"
[ -n "\${OPTIO_TEAM_NAME:-}" ] && set -- "$@" --trailer "Optio-Team: \${OPTIO_TEAM_NAME}"
[ $# -gt 0 ] || exit 0
git interpret-trailers --in-place --if-exists addIfDifferent "$@" "$msg" || true
exit 0
`;
}

/**
 * The setup lines (run in the task's worktree) that install the hook when
 * the run carries anything to add: into the repository's common hooks
 * directory, written to a temporary file and renamed so two tasks starting
 * in one pod never see half a hook. A repository that set `core.hooksPath`
 * keeps its hooks; the trailers then come from the prompt. The setup script
 * runs under `set -e`: the install is a subshell whose failure is only
 * reported, never the end of the run.
 */
export function commitTrailerHookSetup(): string[] {
  const script = Buffer.from(prepareCommitMsgHook(), "utf8").toString("base64");
  return [
    `if [ -n "\${OPTIO_RUN_URL:-}\${OPTIO_COMMIT_CO_AUTHOR:-}\${OPTIO_JIRA_KEY:-}" ]; then`,
    `  if [ -z "$(git config --get core.hooksPath 2>/dev/null)" ]; then`,
    // Every step is chained with &&: `set -e` doesn't apply inside a subshell
    // that is part of an && / || list.
    `    ( OPTIO_HOOKS="$(cd "$(git rev-parse --git-common-dir)" && pwd)/hooks" &&`,
    `      OPTIO_HOOK="$OPTIO_HOOKS/prepare-commit-msg" &&`,
    `      mkdir -p "$OPTIO_HOOKS" &&`,
    `      { if [ -f "$OPTIO_HOOK" ] && ! grep -q '${COMMIT_HOOK_MARKER}' "$OPTIO_HOOK"; then mv -f "$OPTIO_HOOK" "$OPTIO_HOOK.optio-chained"; fi; } &&`,
    `      printf '%s' '${script}' | base64 -d > "$OPTIO_HOOK.tmp.$$" &&`,
    `      chmod +x "$OPTIO_HOOK.tmp.$$" &&`,
    `      mv -f "$OPTIO_HOOK.tmp.$$" "$OPTIO_HOOK"`,
    `    ) && echo "[optio] Commit trailers hook installed" || echo "[optio] Could not install the commit trailers hook; the prompt names the trailers"`,
    `  else`,
    `    echo "[optio] core.hooksPath is set; commit trailers come from the prompt"`,
    `  fi`,
    `fi`,
  ];
}
