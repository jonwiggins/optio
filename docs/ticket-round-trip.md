# Ticket round trip

When a ticket becomes work in Optio, the ticket can hear how that work goes,
without anyone copying links around, and a person can steer the work from
the ticket. It works with every ticket source Optio syncs: **GitHub Issues**,
**GitLab Issues**, **Jira** (Cloud and Server / Data Center), **Linear** and
**Notion**. It is off until someone turns it on for a provider; until then a
ticket gets the one comment it always got when work starts ("Optio is
working on this issue").

With it on:

- **Comments** on the ticket: when the work starts (a link to the run), when
  its merge request opens (the MR's link), when it merges, and when it fails
  or waits for a person (with the kind of failure or what it waits for; the
  error itself stays behind the run link).
- **The work's link**, kept in one place and updated as the work goes: first
  to the run, then to the merge request with its state. There is never a
  second one for the same work.
- **A status per step**: the ticket moves to the status picked for when the
  work starts, when the MR opens, when it merges, when it fails.
- **Follow-ups from the ticket**: a person's new comment on the ticket resumes
  the work with the comment as the instruction, while the work waits for a
  person or has its MR open.

How each service does each of these:

| Service       | Comments       | The work's link                                         | Statuses                                         | Mentions                    |
| ------------- | -------------- | ------------------------------------------------------- | ------------------------------------------------ | --------------------------- |
| GitHub Issues | issue comments | one comment by Optio, edited in place                   | Open / Closed, or one of the repository's labels | `@login`                    |
| GitLab Issues | notes          | one note by Optio, edited in place                      | Open / Closed, or one of the project's labels    | `@username`                 |
| Jira          | comments       | a remote link (`optio:<task id>`) Jira updates in place | the project's statuses, through the workflow     | `[~name]`, `[~accountid:…]` |
| Linear        | comments       | a link attachment, moved from the run to the MR         | the team's workflow states                       | `@displayName`              |
| Notion        | page comments  | none (the comments carry the links)                     | the options of the database's status property    | `@<integration name>`       |

## Whose a provider is

Settings → Integrations → Tickets → **Add Provider** asks whose it is, and its
tickets become that owner's work:

| Owner                             | Who adds and changes it | Its tickets become                                                      |
| --------------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| Organization (a deployment admin) | a deployment admin      | the deployment's work on any repository, exactly as before owners       |
| Organization (a workspace admin)  | that workspace's admins | the workspace's work, on the workspace's repositories only              |
| A team (`team:<id>`, teams on)    | the team's admins       | the team's work, run with the team's secrets (see [teams.md](teams.md)) |
| Private (`me`)                    | that person             | their own work, run with their own secrets                              |

- Every provider from before owners has no workspace: it stays the
  deployment's, synced as before, and only a deployment admin changes,
  tests or removes it (`POST /api/tickets/providers` with `owner` left out,
  by a deployment admin, makes one too). Anyone else's provider belongs to
  their workspace, and a ticket of it becomes work only on a repository
  registered in that workspace: a `repo:` label, a full URL or the
  provider's `repoUrl` that names anything else is skipped.
- A workspace admin sees every provider in the workspace and may remove a
  team's or a person's (offboarding), but never change or use it.
- A team's or a person's provider waits while its owner can't have work: the
  person is no longer a member of the workspace (or is a viewer), teams are
  off, or the team's creator left the team. It isn't read, and nothing is
  written on its tickets, until that changes. Its tickets fire no one else's
  ticket triggers; the organization's do, as before.
- Only the deployment's GitHub provider may leave out its token and borrow
  the deployment's GitHub App or token; every other provider brings its own.
- Credentials are kept encrypted (`ticket-provider:<id>`); the list never
  returns them, also not a GitLab token an older row kept in its config.

### Jira Server / Data Center

The Jira form offers **Jira Cloud** (the site URL, an email and an API token)
or **Server / Data Center** (the base URL with its context path,
`https://jira.example.com/jira`, and a personal access token, or a username
and password). A server behind a private certificate takes its CA as a PEM
bundle (`caPem`), trusted for that provider's requests only. **Extra JQL** is
ANDed into the search. **Test** (also run once after saving) reaches the
server with the stored credentials and shows its name, version and the
account, or why it failed; never the token or a response body. Every Jira
call, Cloud's and the server's, goes through the outbound guard, which pins
the vetted address and refuses redirects.

Only work the ticket sync made from the provider's ticket takes part. Anyone
may create a task through the API that names a ticket (`ticketSource`,
`ticketExternalId`, `metadata`); Optio never writes on that ticket for it, and
the ticket's comments never steer it. The sync's own claim on the ticket
(`ticket_sync_claims`) is what tells them apart. Work made before the round
trip existed doesn't name its provider and takes no part either.

## Turning it on

Settings → Integrations → Tickets → the provider → **Round trip**. Who may
change it is who may change the provider (see above).

| Setting                                  | Default (once on) | What it does                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Write back to the tickets Optio works on | off               | The switch. Off: the single comment at start, nothing else. On: what follows.                                                                                                                                                                                                  |
| Comment on the ticket                    | on                | The comments below (instead of the single comment at start).                                                                                                                                                                                                                   |
| Link the run, then the merge request     | on                | The work's link (not offered for Notion).                                                                                                                                                                                                                                      |
| Move the ticket                          | none              | A status for each of: work started, merge request opened, merged, failed. The pickers list the service's statuses (see the service's section). Empty keeps the ticket where it is.                                                                                             |
| Follow-ups from the service              | Any comment       | `Any comment`: a new comment by someone who may change the repository or project resumes the work. `Mentions only`: only a comment that starts with `/optio`, mentions `@optio`, or mentions the provider's own account (see the table above). `Off`: comments are never read. |

**Test** takes a ticket as the service names it (`PLAT-1`, `12` or `#12`,
`ENG-1`, a Notion page id or link; an issue link works for GitHub, GitLab
and Linear too), reads its status and where it can go from there, and says
for each step of the mapping in the form (saved or not) whether the ticket
can move there now, is there already, or can't get there from its current
status. Nothing moves.

Turning the round trip on (or widening follow-ups) starts it from that
moment: comments written on the tickets before then are never follow-ups,
and tickets the sync skipped before are not told why (see below). Switch
follow-ups to `Mentions only` if people talk on your tickets a lot.

The links in comments point at `<PUBLIC_URL>/tasks/<id>`. Without `PUBLIC_URL`
(Helm `publicUrl`) a comment names the run's id instead and there is no link
to the run.

## What the ticket hears

| When                                                    | Comment                                                        | Status (if mapped) | The work's link                  |
| ------------------------------------------------------- | -------------------------------------------------------------- | ------------------ | -------------------------------- |
| The work is queued for the first time                   | "Optio started work on this ticket. Follow the run."           | Work started       | to the run, "In progress"        |
| Its merge request opens                                 | "Optio opened merge request !12 for this ticket (the run)."    | MR opened          | to the MR, "Waiting for review"  |
| It comes back with the same MR after a ticket follow-up | "Optio pushed changes for Ada's comment to merge request !12." | —                  | "Updated, waiting for review"    |
| The MR merges                                           | "Optio's merge request !12 was merged."                        | Merged             | "Merged" (Jira: struck through)  |
| The run fails                                           | "Optio's run failed: the kind. Details: the run."              | Failed             | "Failed: the kind"               |
| The work waits for a person (still so a minute later)   | "Optio is waiting for a person: what for. See the run."        | —                  | "Waiting for a person: what for" |
| A ticket comment resumed it                             | "Optio is working on Ada's comment: the run."                  | —                  | —                                |
| The sync skips the ticket: no repository matches it     | Once: why, and the `repo:<owner>/<name>` label to add.         | —                  | —                                |

A pull request on GitHub is "pull request #12"; a GitLab merge request is
"merge request !12".

- Each of these happens once per event: the start once per piece of work
  (a resume or a retry is not a new start), the MR once per MR, each failure
  once. Comments are each service's markup: Markdown on GitHub, GitLab and
  Linear, rich text with links on Notion, wiki markup on Jira Server / Data
  Center and ADF on Jira Cloud.
- The reason on the ticket is what the work waits for ("its merge request's
  pipeline fails", "a review asked for changes", "the agent finished without
  opening a merge request", "its plan is ready for review") or the kind of
  failure as the run page names it ("Agent exited with code 1", "Out of
  memory"). Never the error message itself: it can end with the agent's
  output, and everyone who may browse the ticket's project reads the ticket,
  not only those who may see the work. A failure Optio can't name gets no
  reason; the run link has the details.
- "Waiting for a person" is sent only when the work still waits about a
  minute later: an automatic resume (a failed pipeline, a review) passes
  through that state on its way back to the queue, and the ticket doesn't
  need to hear about it. A retry of it is dropped once the work moved on.
- The first sweep of a new provider only notes the backlog (its tickets
  become pending work) and says nothing on the tickets, also not on skipped
  ones; a ticket hears from Optio once its work starts. The tickets that
  first sweep skipped are not told why later either (the services' searches
  have no "since", so every sweep sees them again); only a ticket that turns
  up afterwards is. The same holds for the first sweep after the round trip
  is turned on.
- A status move goes to the mapped status from wherever the ticket is now
  (on Jira, through whichever transition leads there). If the service has no
  such status (a label the repository doesn't have, a workflow that doesn't
  allow it from here), nothing moves and the reason is kept on the event; it
  is not retried.
- If the service can't be reached or refuses a write, the ticket sync tries
  the event again after 1, 4, 9, 16, … minutes, eight attempts in all (about
  two hours); a comment that went through is never posted again. When a retry
  comes due after a newer event of the same work reached the ticket (the
  start, after the MR's), it leaves out what the newer one already did — its
  comment, status move or link — so a late retry never moves the ticket back,
  relabels the link or comments out of order. (A late start after a "waiting
  for a person" note still moves the ticket to its "work started" status:
  the note moved nothing.)
- Turning the round trip off drops the events not sent yet; nothing more is
  written on the provider's tickets.

## Follow-ups from the ticket

The ticket sync (every `OPTIO_TICKET_SYNC_INTERVAL`, default a minute) reads
the comments on the tickets of work that waits — needs a person, or has its
MR open — and resumes each piece of work that has new instructions: the
comments go to the agent as its next instruction (who wrote what), with the
open MR named so it pushes to the same branch instead of opening another.
Optio then says on the ticket that it took the comment. Comments written while
the work was running are read once it waits again; several are taken
together. Each sync reads up to 25 pieces of waiting work per provider and
takes turns, so with more than that a comment may take a few sync intervals
to be read.

Optio never answers itself:

- comments Optio posted (it keeps their ids, its link comments too) and
  **every comment written as the provider's own account** are never read.
  Give the provider an account of its own (a service account or a bot user):
  a person whose personal token the provider uses can't steer work with their
  own comments;
- comments by apps and integrations are not instructions: GitHub comments by
  a bot account or made through a GitHub App, GitLab's system notes, Linear
  comments written by an integration, and the notes a code host's Jira
  integration leaves ("… mentioned this issue in a commit / merge request of
  …");
- comments older than the work were in its prompt already; each comment is
  taken once;
- comments older than the round trip on the provider (when it was turned on,
  or the provider's creation) and, after follow-ups were widened (`Off` →
  `Mentions only` → `Any comment`), comments older than that change are not
  instructions either: they weren't written for Optio;
- one piece of work takes at most `OPTIO_TICKET_FOLLOW_UP_LIMIT` (Helm
  `tickets.followUpLimit`, default 10) follow-ups; after that Optio says once
  on the ticket that it takes no more, and a person continues from Optio;
- the start comment and the "work started" status move happen once per piece
  of work, not at every resume.

Who may steer the work this way: the work runs with its owner's (or team's)
credentials, so a comment is an instruction only from someone the service
says may change the work's repository or project:

| Service | Whose comments steer                                                                              |
| ------- | ------------------------------------------------------------------------------------------------- |
| GitHub  | the repository's owner, its organization's members and collaborators (`author_association`)       |
| GitLab  | a Developer or above of the project, inherited membership included (`GET …/members/all/:user_id`) |
| Jira    | anyone with an account but an app, and not a Service Management customer (Cloud's `accountType`)  |
| Linear  | the workspace's members (a comment needs an account there)                                        |
| Notion  | the workspace's members and guests the page is shared with                                        |

Anyone else's comment is left alone: on a public GitHub repository a
stranger's comment never reaches the agent. A comment GitLab refused is asked
about once and doesn't count against the limit. Use `Mentions only` or `Off`
when a ticket's comments are mostly conversation.

## Each service

What each service's implementation calls, and what it was checked against.
The GitHub, GitLab, Linear and Notion implementations follow the service's
public API reference; every implementation, Jira's too, is tested against an
in-process fake of that API (`apps/api/src/test-utils/fake-*.ts`), not
against the live service.

### GitHub Issues

- REST API at `https://api.github.com` (version `2022-11-28`), with the
  provider's token: issue comments (`POST`/`GET /repos/{owner}/{repo}/issues/{n}/comments`,
  newest pages read, ascending by id), the link comment edited with
  `PATCH /repos/{owner}/{repo}/issues/comments/{id}`, the issue's state
  (`PATCH …/issues/{n}`, `state_reason: completed` when closing), labels
  (`GET …/labels`, `POST …/issues/{n}/labels`,
  `DELETE …/issues/{n}/labels/{name}`), and `GET /user` for its own account.
- Statuses are **Open** and **Closed**, and the repository's labels. Moving to
  a label adds it and takes off the labels mapped to the other steps, so an
  issue carries one of them at a time; moving to Open or Closed changes the
  state and takes them off too. A label the repository doesn't have is never
  created: the move is noted as impossible.
- The pull request links the issue itself: the agent's PR description says
  `Closes #<n>` (Optio's prompt asks for it), which GitHub shows on the issue and acts
  on at merge. The link comment carries a hidden marker `<!-- optio:<task id> -->`.
- The token needs to read and write issues (a fine-grained token's Issues:
  read and write; a classic token's `repo`). A GitHub App installation token
  works too: it has no `GET /user`, so Optio checks it is one
  (`GET /installation/repositories`) and its own comments are told apart as
  the App's.
- Checked against GitHub's REST reference for issues, issue comments and
  labels; tested against `fake-github-issues.ts`.

### GitLab Issues

- REST API v4 at the provider's host (`https://<host>/api/v4`, the token as
  `Authorization: Bearer`, through the outbound guard like the sync): notes
  (`POST`/`GET /projects/:id/issues/:iid/notes`, newest first, system notes
  left out), the link note edited with `PUT …/notes/:note_id`, the issue
  (`PUT /projects/:id/issues/:iid` with `state_event`, `add_labels`,
  `remove_labels`), the project's labels (`GET /projects/:id/labels`, its
  groups' included), `GET /user`, and
  `GET /projects/:id/members/all/:user_id` for whose notes steer.
- Statuses are **Open** and **Closed**, and the project's labels (scoped
  labels such as `workflow::doing` work), with the same rule as GitHub's: a
  move takes the other steps' labels off.
- The merge request relates itself to the issue: its description says
  `Closes #<iid>` (Optio's prompt asks for it), which GitLab lists on the issue and
  acts on at merge.
- The token needs the `api` scope (a project or group access token, or a bot
  user's personal token).
- Checked against GitLab's REST reference for issues, notes and labels;
  tested against `fake-gitlab-issues.ts`.

### Jira

- Cloud through REST v3 (comments in ADF), Server / Data Center through REST
  v2 (comments in wiki markup with `[text|url]` links), with the same clients,
  credentials and private CA (`caPem`, else `NODE_EXTRA_CA_CERTS`) as the
  sync, and through the outbound guard.
- The work's link is a remote link with `globalId` `optio:<task id>`, which
  Jira updates in place; a merged MR's link is marked resolved (struck
  through).
- Statuses are the project's (`projectKey`; every issue type's, once each),
  or every status on the server when the provider names no project. A move
  goes through whichever transition leads to the mapped status from the
  issue's status now; when none does, nothing moves.
- Mentions are `[~name]` / `[~key]` on Server / Data Center and
  `[~accountid:…]` on Cloud. An app's comment (Cloud's `accountType: app`)
  is never an instruction, nor a Service Management customer's, nor that of
  anyone without Edit Issues on the issue (asked through
  `user/permission/search?permissions=EDIT_ISSUES&issueKey=…`, by accountId
  on Cloud and by user name on Server / Data Center, where the answer must
  name the same account).
- The Jira account needs to comment, transition, and add remote links on the
  project's issues (Browse, Add Comments, Transition Issues, Link Issues),
  and Browse Users and Groups to ask who may edit an issue.
- The calls go through the `jira.js` client the sync uses; tested against
  `fake-jira.ts` (Server / Data Center, REST v2).

### Linear

- GraphQL at `https://api.linear.app/graphql` with the provider's API key:
  `commentCreate`, an issue's `comments` (those written by an integration
  left out), `attachmentCreate` / `attachmentDelete` for the link (Linear
  updates the attachment with the same URL on the same issue; when the link
  moves from the run to the PR, the old one is removed), `workflowStates`,
  `issueUpdate` with the state's id, and `viewer`. Issues are looked up by
  their identifier (`ENG-123`).
- Statuses are the workflow states of the provider's team (`teamId`), or of
  every team, once per name, when it names none.
- Checked against Linear's GraphQL documentation and schema (the field names
  of `@linear/sdk`'s generated types); tested against `fake-linear.ts`.

### Notion

- REST API at `https://api.notion.com/v1` (`Notion-Version: 2022-06-28`, as
  the sync's client) with the integration's token: comments
  (`POST /v1/comments` on the page, `GET /v1/comments?block_id=<page>`, which
  returns open discussions), the database's status property
  (`GET /v1/databases/:id`, the property named by `statusProperty`, default
  "Status"; a select property works too), and the page's status
  (`GET`/`PATCH /v1/pages/:id`).
- No link: Notion has nothing that updates in place, so the comments carry
  the links. Statuses are the property's options, grouped as Notion groups
  them (To-do, In progress, Complete).
- The integration needs the **Read comments** and **Insert comments**
  capabilities, and **Update content** to move a page.
- Checked against Notion's API reference (create and list comments, update
  page properties, the bot user); tested against `fake-notion.ts`.

## For operators

- `OPTIO_TICKET_FOLLOW_UP_LIMIT` (default 10) and `PUBLIC_URL` (Helm
  `publicUrl`) for the links. Everything else is per provider, in the app.
- Calls to a host the provider names (GitLab, Jira) go through the outbound
  guard, like the sync; each round-trip call gives up after 20 seconds.
- Database (migration `1794732000_ticket_round_trip.sql`, additive): the
  provider's `workspace_id`, `owner_user_id` and `owner_team_id` (a person's
  or a team's provider goes when they do), and `ticket_writebacks`: one row per event, the steps
  that went through, the comment ids Optio posted (`comment_id`), the link it
  keeps as a comment or attachment (`link_id`), the comments it took as
  follow-ups. Settings live on the provider row
  (`ticket_providers.config.roundTrip`, `enabled` among them), with two
  moments Optio keeps there itself: `since` (when the round trip began for
  the provider) and `followUpsSince` (when its follow-ups last widened). Every
  provider starts with the round trip off.
- A follow-up is on the work's timeline (trigger `ticket_comment`, who wrote
  what).

## API

| Route                                                | Who                             | What                                                                                                                               |
| ---------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /api/tickets/providers/:id/round-trip`          | whoever may change the provider | `{ enabled?, comments, remoteLink, followUps, transitions: { started, mrOpened, merged, failed } }` (`enabled` defaults to true)   |
| `GET /api/tickets/providers/:id/round-trip/statuses` | the same                        | the statuses to map to, and whose they are (`project`, `server`, `repository`, `team`, `workspace`, `database`)                    |
| `POST /api/tickets/providers/:id/round-trip/check`   | the same                        | the Test button: `{ issueKey, transitions? }` → the ticket's status and each step's outcome; an id the service can't take is a 400 |
| `POST /api/tickets/providers/:id/test`               | the same                        | the provider's connection test (Jira): the server, its version and the account, or why not                                         |
| `POST /api/tickets/providers`                        | see "Whose a provider is"       | `owner`: `workspace` (default), `me` or `team:<id>`                                                                                |

Code: `packages/ticket-providers/src/round-trip.ts` (the interface) and
`github-round-trip.ts`, `gitlab-round-trip.ts`, `jira-round-trip.ts`,
`linear-round-trip.ts`, `notion-round-trip.ts` (one per service);
`packages/shared/src/ticket-round-trip.ts` (the settings, what each source
supports); `apps/api/src/services/ticket-writeback.ts` (what the ticket
hears), `services/ticket-follow-ups.ts` (follow-ups),
`services/ticket-round-trip-marks.ts` (`since`, `followUpsSince`),
`routes/ticket-round-trip.ts`; web `components/settings/ticket-round-trip.tsx`.
Owners: `routes/tickets.ts`, `services/ticket-sync-service.ts`
(`providerOwnerStanding`, the workspace's repositories). Hooks in existing
files: `task-service.ts` (`announceTransition`), `ticket-sync-service.ts`,
`server.ts`; web `app/settings/page.tsx`. Tests:
`services/ticket-writeback.int.test.ts`, `services/ticket-follow-ups.int.test.ts`
(Jira), `services/ticket-round-trip-providers.int.test.ts` (GitHub, GitLab,
Linear, Notion), `routes/ticket-round-trip.int.test.ts`,
`routes/tickets-owners.test.ts`, `services/ticket-sync-owners.test.ts`,
`packages/ticket-providers/src/jira-server-transport.test.ts`.
