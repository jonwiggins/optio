# Pull requests

The **Pull requests** page (`/reviews`) lists every open pull request (GitLab:
merge request) in the workspace's repositories, and for each one answers a
single question: _whose move is it, and what is it?_

Rows are grouped into three sections:

| Section          | Means                                                                            |
| ---------------- | -------------------------------------------------------------------------------- |
| **Your move**    | Something only you can do: fix CI, address a review, reply, review, merge, …     |
| **Agents on it** | An Optio task is working on the PR right now                                     |
| **Waiting**      | Reviewers, CI or the author have the move, or it's a draft still being worked on |

A row's age turns amber when it has waited too long: a day when it's your move,
two when it's someone else's.

The views are **Needs me** (your moves, plus agents you started; its count is
your moves only), **Mine** (you opened it, or an Optio agent you started did),
and **All open**. In All open, a PR you have no part in is labelled by its plain
state (CI failing, Changes requested, Approved, …).

## Who "you" are

Optio matches PRs to you by your handle on the platform: the GitHub / GitLab
username you signed in with, or the one you link on the page ("Who are you on
GitHub?", `PUT /api/pr-inbox/handles`, stored on `users.git_handles`). People
who sign in with Google, OIDC or LDAP link theirs once. Until a handle is set
only **All open** is available. When the deployment's GitHub token belongs to a
person (a PAT, not an App), the page offers that account as a one-click guess.

## The next action

`derivePrStatus` (`packages/shared/src/pr-inbox/status.ts`) turns the platform's
facts into one action. The first rule that applies wins.

**When you opened it** (or an Optio agent you started did):

1. **Fix CI**: a check failed (named in the row).
2. **Draft**: it's a draft. Listed under Waiting: nobody is waiting on it yet.
3. **Resolve conflicts**: it can't merge until conflicts are resolved.
4. **Address changes**: a reviewer requested changes and nothing was pushed since.
5. **Reply**: an unresolved review thread where someone else spoke last, or a
   conversation comment after your last word. Bots (`[bot]`, dependabot,
   renovate, codecov, …) never need a reply.
6. **Update branch**: branch rules require it to be up to date with its base.
7. **CI running**: checks are still going (someone else's move).
8. **Merge**: approved, green and mergeable. Approved but blocked by branch
   rules, or with mergeability not computed yet, waits instead.
9. **Awaiting review**: reviewers are requested, or you pushed after changes
   were requested. **Request review** when nobody is asked yet.

**When you're a reviewer**:

- **Review**: you're asked and haven't reviewed yet (**Optio review ready**
  when Optio's own review has a draft waiting). While its CI is red it's the
  **Author's move** instead: most teams don't review a red PR.
- **Re-review**: you're asked again, or new commits landed since you requested
  changes and CI is green. While that CI runs it's **CI running**; if it
  failed, the **Author's move**.
- **Reply**: someone answered your thread.
- **Author's move**: you requested changes and nothing new has happened.
- **Merge**: a contributor's fork PR you approved, once it's green (its author
  can't merge it).

**Assigned or mentioned**: **Reply** to a fresh mention, else Watching.

**Nobody's yet**: an outside contribution (a fork PR, not a draft) with no
reviewer and no review four hours after it was opened is **Needs a reviewer**
for everyone in the workspace, so it doesn't get lost.

An **Optio task** on the PR overrides all of this: queued, starting or running
is **Agent working**; stopped and waiting on a person is **Agent needs you**,
for the person who started it only.

## Buttons

- **Fix with agent / Address with agent / Resolve with agent / Update with
  agent** (`POST /api/pr-inbox/agent`): the Optio task that owns the PR resumes
  (when it's waiting on you) or starts a fresh session on its branch (when it's
  idle with its PR open). A PR no task owns gets a new Repo Task that checks out
  the PR's own branch, pushes there and never opens another PR. The PR is
  attached to the task before it queues, so the task follows that PR's
  lifecycle (auto-resume, complete on merge). Not offered for a fork's PR:
  Optio can't push to it.
- **Review** opens the PR's diff on GitHub / GitLab; **Draft with Optio**
  beside it starts an Optio review, and **Optio's draft** opens one.
- **Merge** asks first (target branch, CI, approvers), uses the repository's
  preferred merge method (squash when allowed), and passes the head commit the
  page saw: GitHub refuses the merge if someone pushed since.

## Where the data comes from

`GET /api/pr-inbox` (`apps/api/src/services/pr-inbox-service.ts`) reads each
repository with the deployment's token:

- **GitHub**: one GraphQL query per 25 open PRs (checks rollup, merge state,
  latest reviews, review threads, recent comments; `github-pr-facts.ts`).
  GitHub Enterprise uses `https://<host>/api/graphql`.
- **GitLab**: the open MR list, then per MR its detail (`head_pipeline`,
  `detailed_merge_status`), reviewers, discussions and newest commit
  (`gitlab-pr-facts.ts`), at most 40 MRs per project.
- **CodeCommit**: the plain list; no checks, reviews or threads.

Each repository's answer is cached for 60 seconds per API instance. Any GitHub
or GitLab webhook delivery for the repository drops it, and **Refresh** re-reads
anything older than 10 seconds. A repository that can't be read is named on
the page with the reason; the rest still show.
