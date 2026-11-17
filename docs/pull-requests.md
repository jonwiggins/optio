# Pull requests

The **Pull requests** page (`/reviews`) lists every open pull request (GitLab:
merge request) in the workspace's repositories, and for each one answers a
single question: _whose move is it, and what is it?_

The page has three layers, top to bottom:

1. **Lenses**: which PRs, by your relation to them. **Needs me** (your moves,
   plus every PR of yours, including those waiting for review or CI, listed
   under Waiting; its count is your moves only), **Review
   requested** (you're asked, or nobody has picked up an outside
   contribution), **My PRs** (you opened it, or an Optio agent you started
   did), **Reviewed by me**, and **All on my repos**.
2. **Headline numbers**, counted within the lens: **Ready to merge**
   (approved, green, mergeable, not a draft), **CI failing**, **Needs rebase**
   (conflicts, or behind a base that branch rules require it to be on), **Open
   comments** (unresolved threads, or a reply you owe), **Needs review** and
   **Agents working**. Click one to narrow the list to it (`?bucket=`; click
   again to clear). A narrowed list offers **bulk actions** for the PRs they
   apply to, each confirmed with the list of PRs first: merge all, re-run
   failed checks, fix with agents, update branches, resolve conflicts with
   agents, draft reviews with Optio, address comments with agents.
3. **The list**, grouped by whose move it is:

| Section          | Means                                                                            |
| ---------------- | -------------------------------------------------------------------------------- |
| **Your move**    | Something only you can do: fix CI, address a review, reply, review, merge, …     |
| **Agents on it** | An Optio task is working on the PR right now                                     |
| **Waiting**      | Reviewers, CI or the author have the move, or it's a draft still being worked on |

Each row shows its next action, why, and labelled chips for CI (passing /
failing / running / none), reviews (approved / changes requested), merge state
(conflicts / behind / blocked) and open threads. A row's age turns amber when
it has waited too long: a day when it's your move, two when it's someone
else's. A PR you have no part in is labelled by its plain state (CI failing,
Changes requested, Approved, …).

GitHub issues stay in the **Inbox** (`/issues`).

## Who "you" are

Optio matches PRs to you by your handle on the platform: the GitHub / GitLab
username you signed in with, or the one you link on the page ("Who are you on
GitHub?", `PUT /api/pr-inbox/handles`, stored on `users.git_handles`). People
who sign in with Google, OIDC or LDAP link theirs once. Until a handle is set
only **All on my repos** is available. When the deployment's GitHub token belongs to a
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

Every row also has a **⋯** menu with everything its state allows, whoever's
move it is: open the diff or the Optio task, merge (when ready), **Update
branch** (GitHub "Update branch" / GitLab rebase), **Re-run failed checks**
(GitHub Actions' failed jobs / the GitLab pipeline), the agent actions,
**Approve** (not your own PR, nor one you already approved), Optio's review,
and copy link. Update, re-run and approve go through `POST
/api/pr-inbox/actions` with your own git token where you have one, like
merging.

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
