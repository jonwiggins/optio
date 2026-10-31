# Merge confirmation and review depth

Two optional controls over what happens to a PR after the agent opens it. Both
default to what Optio has always done.

## Merge confirmation

Off by default. With it off, "Auto-merge" on a repo, a Task's "Merge it for me"
and a scheduled Task's auto-merge work exactly as before: the checkbox alone
decides, and the reconciler merges once CI passes.

Turn it on when an automatic merge should always be a deliberate choice by a
person:

- **Settings → Access → Automatic merging** (deployment admins), or
- `OPTIO_MERGE_CONFIRMATION=true` (Helm: `merge.confirmation: true`). A value
  saved in Settings wins over the environment; "Follow the deployment" removes
  it again.

With it on:

- Ticking any auto-merge checkbox (repo settings, new repo, the work form) opens
  a "Merge automatically?" dialog. Only "Yes, merge automatically" turns it on.
  The API refuses a write that turns merging on without
  `autoMergeConfirmed: true` (`400`); saving a setting that was already
  confirmed doesn't ask again. Turning merging off clears the confirmation, so
  turning it on again asks again.
- Each confirmation records who and when: the repo page shows "Confirmed on
  <date> by <name>", and the audit trail records every confirmation
  (`auto_merge.confirm`) and a repo or scheduled Task turning merging off
  (`auto_merge.off`).
- The reconciler merges only a setting that was confirmed. A setting that was
  on before the switch was turned on, or one a config file turned on, stays on
  but merges nothing until a person confirms it in the app (a file can't
  confirm). Tasks spawned by a scheduled Task carry its confirmation.
- Agents can't confirm. The controller's work tools drop `autoMergeConfirmed`,
  and an agent run's own `merge_pr` call is refused (`403`) unless it runs in a
  session whose writes wait for the person's approval. A person's own
  controller token, and the Merge button, merge as before.
- Right before it merges, Optio reads the PR and its reviews again (every
  page on GitHub; GitLab and CodeCommit read what they always read). It doesn't merge a draft or a PR with conflicts, and never over a
  reviewer whose latest review still requests changes, even when someone else
  approved later. In that last case the task goes to **Needs attention** with
  the reason instead of being retried.

On GitLab the re-read covers drafts, conflicts and approvals; merge request
discussions don't yet count as "changes requested" there.

Switching it off again returns to the checkbox alone; recorded confirmations
are kept for the next time it is on.

## Review depth

How deep a code review goes, for reviews of PRs Optio opened and of PRs it
didn't:

- **Thorough** (the default): the review Optio has always run, with the repo's
  test command and turn budget.
- **Light**: the diff only. The test command is not passed, the turn budget is
  halved (at least 5), and a short note after the review prompt asks for the
  top five findings and no nits. Custom review prompts get the same note and
  can read `{{REVIEW_DEPTH}}`.

Set it per workspace (**Settings → Code review → Depth**), per repo (repo
settings → Code Review → Depth; "Workspace default" follows the workspace), or
per piece of work that asks for its own review (Where → Environment → Review
depth). Work can only make a review more careful: a light ask on a repo that
reviews thoroughly stays thorough.

```bash
# A light review on one repo
curl -X PATCH https://optio.example.com/api/repos/<id> \
  -H 'Content-Type: application/json' -d '{"reviewDepth":"light"}'
```
