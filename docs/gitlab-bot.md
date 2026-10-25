# @-mentions in GitHub and GitLab comments

Mention Optio's bot in a comment on an issue, a merge request (GitLab) or
a pull request (GitHub) and Optio works for you, as you, and answers in the
same thread. It is off on both platforms until a deployment admin turns it
on (below). The examples say merge request and pipeline; on GitHub the same
works on pull requests and their checks (GitHub Actions' failed jobs):

```text
@optio-bot add a line to the README saying how to run the tests
@optio-bot fix pipeline
@optio-bot team:platform bump the base image to the new release
```

| Where you comment                                                | What Optio does                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An **issue**                                                     | Starts work in that project from the issue: its title and description and your comment. The agent opens a merge request that says `Closes #<issue>`.                                                                                                                                 |
| A merge request **Optio opened**                                 | Resumes that work with your comment as the next instruction: the agent changes the code on the same branch and pushes; no new merge request.                                                                                                                                         |
| **Anyone else's** merge request                                  | Starts work from the merge request's source branch. The change comes as a new merge request **into that branch**, so its author can take it in; Optio never pushes to their branch.                                                                                                  |
| `fix pipeline` (or `fix ci`, `fix the build`) on a merge request | Reads the failed jobs of the merge request's latest pipeline (names, stages, the end of each log, secrets masked) and hands them to the agent: on Optio's own merge request it resumes the work to fix them; on anyone else's it opens a merge request with the fix into its branch. |
| `help`, or just the mention on a merge request                   | Answers with what it can do.                                                                                                                                                                                                                                                         |

What follows the mention is the instruction; the rest of the comment
(code blocks included) goes to the agent as you wrote it. `fix pipeline`,
`fix ci` and `fix the build` are the command when they are the whole
request, or are followed by punctuation or a new line and more words
(`fix pipeline: only the lint job`, `fix ci, then rerun`). "fix the build
script so it works on Windows", "fix ci config …" or "fix build.gradle …"
are ordinary requests about those files. A mention inside
code (`` `@optio-bot` `` or a fenced block) or in a quoted line (`> …`)
doesn't count, so quoting an earlier request never starts it again.

## What you see

1. An **eyes** award on your comment: Optio saw it.
2. A **reply in your thread** with a link to the run in Optio (`/work/<id>`),
   or the reason it won't act (below).
3. When the run ends, **one more reply** with the result: the merge request
   it opened ("ready for your review"), that it pushed the changes to this
   merge request, the reason it needs a person, why it failed, or that it was
   cancelled.

The replies come from the bot's GitLab user and start with `@you`, so GitLab
notifies you.

## Who Optio works as

The run is **yours**: Optio finds your Optio account first by the GitHub or
GitLab account **you sign in to Optio with** (GitHub sign-in on github.com;
GitLab sign-in on the GitLab it uses, `GITLAB_OAUTH_BASE_URL`), when that is
where you commented. Otherwise by your **email** (the one GitLab shows on
the comment, else the one your profile shows the bot's token; GitHub's
public email). When the platform gives an email, only the email counts:
if no Optio account has it, Optio says it can't find you, even when an
account has your username. Only when GitLab shows no email does Optio use
your **directory username** (your GitLab username is the same as your
Optio sign-in name when both use the deployment's directory).

New work is your own (private) work, or a team's when you add
`team:<team>` (its slug or name; you must be a member). It runs with
your gateway token (the team's for a team's work), your GitLab token if you
have one, and shows up in your Work list like work you started in Optio.
Resuming Optio's own merge request keeps that work's owner: you may do it
when Optio's Resume button would let you (your own work, your team's, or the
organization's).

Optio answers in the thread instead of acting when:

| Reply says                                                              | Why                                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I can't find you in Optio                                               | No Optio account has the email your GitLab profile gives (or, when GitLab shows no email, your username). Sign in to Optio once, then mention it again.                                              |
| More than one Optio account matches                                     | Two accounts share your email or username; an Optio admin sorts them out.                                                                                                                            |
| Your Optio account is disabled                                          | The directory sync or an admin disabled it ([directory-sync.md](directory-sync.md)).                                                                                                                 |
| You aren't a member of the Optio workspace that has …                   | The project is a repo in a workspace you're not in.                                                                                                                                                  |
| You can look but not start work                                         | You're a viewer there.                                                                                                                                                                               |
| You need at least the Developer role on …                               | Your GitLab role on the project is below Developer.                                                                                                                                                  |
| Add your gateway token under Settings → My tokens                       | The run would have no gateway token (the team's message for a team's work).                                                                                                                          |
| There's no team … / You aren't a member of the team …                   | The `team:` you named.                                                                                                                                                                               |
| This merge request is someone else's work in Optio / isn't yours to see | The merge request is another person's private work in Optio.                                                                                                                                         |
| I'm still working on this merge request                                 | Its run is going on; mention it again once it ends.                                                                                                                                                  |
| This merge request is merged / closed; comes from a fork                | Optio works on open merge requests whose branch is in the project.                                                                                                                                   |
| The latest pipeline … hasn't failed                                     | `fix pipeline` on a merge request whose newest pipeline didn't fail (or is still running).                                                                                                           |
| That's a lot of requests                                                | The rate limit (below).                                                                                                                                                                              |
| Something went wrong on my side … the reference …                       | An unexpected error. The reply names only a reference; an admin finds the error in the API log (`GitLab mention: failed`, `mentionId` = the reference) and the audit entry (`reason` `error`, `id`). |

Every outcome is in the audit trail ([audit.md](audit.md)):
`gitlab_mention.start`, `gitlab_mention.resume` and `gitlab_mention.refuse`
(with the `reason`), with the GitLab `username`, the comment's link and the
run; an unexpected error's entry has the reference as `id`, never the
error's text. A refusal for someone with no Optio account belongs to no workspace,
so deployment admins see it.

## Limits

- **Once per comment.** A comment is handled once however many times GitLab
  delivers it (a retry, "Resend request", the same `X-Gitlab-Event-UUID`, or
  a project hook and a group hook on the same project): Optio keeps the
  GitLab host and comment id. An edited comment isn't a new request.
- **Rate limit.** At most 5 requests (Settings, below) from one person per
  merge request or issue in 10 minutes; that person's next ones get one
  "That's a lot of requests" reply and are otherwise ignored. Each person
  has their own budget, so someone who may not use the bot (no Optio
  account, a Guest) can't use up everyone else's with refused requests.
- **The bot's own comments** are never read as requests, and its replies
  never mention it.
- **Projects Optio knows, on named hosts.** The project must be a repo in
  Optio, on a GitLab host a deployment admin named (the chart's
  `gitlab.hosts` or the setup wizard's GitLab host). A comment anywhere else
  is ignored without a reply: the organization's GitLab token never goes to
  a host only a repo names (as for [credential health](credential-health.md)).
- **One run at a time** per merge request Optio opened.

## For admins: setting it up

The bot is **off by default** on GitHub and on GitLab; turn it on per
platform (Helm `gitlab.bot.enabled` / `github.bot.enabled`, or Settings →
Integrations). While it is off, the receivers don't even store comments.

On GitLab the bot is **the organization's GitLab token's own user**
(`GITLAB_TOKEN` at the organization's scope, the one Optio creates project
webhooks and watches merge requests with), and it must be a **bot or
service account**: a project or group access token's bot user, or a
service account. Optio asks GitLab who that is (`GET /user`) and remembers
it for ten minutes, so if the token is `optio-bot`'s, people mention
`@optio-bot`. When GitLab says the token's user is a person (`bot: false`),
Optio doesn't answer at all, so mentioning that person never starts work;
name the user explicitly (below) only if a person's account really is
meant to be the bot. Nothing else is needed:

- The **project webhooks Optio creates** already send comment (note) events
  to `/api/webhooks/gitlab` ([gitlab.md](gitlab.md)). A webhook you add by
  hand needs **Comments** ticked.
- **`PUBLIC_URL`** makes the replies link to the run; without it they name
  the run's id.
- The token's user must be a member of the project who may comment there
  (Optio's own webhooks already need it to be a Maintainer): it awards the
  emoji, replies, and reads the commenter's role
  (`/projects/:id/members/all/:user`).

**Settings → Integrations → GitLab bot** shows everyone whom to mention on
each named GitLab host. A **deployment admin** can turn it off, give it another
name (a group or project access token's bot user, or a service account people
know by another name: Optio then answers mentions of that name), and change
the rate limit. A value saved there wins over the deployment's; "Follow the
deployment" removes it. The deployment's values:

| Helm value             | Environment                   | Default                                                         |
| ---------------------- | ----------------------------- | --------------------------------------------------------------- |
| `gitlab.bot.enabled`   | `OPTIO_GITLAB_BOT_ENABLED`    | `false`                                                         |
| `gitlab.bot.username`  | `OPTIO_GITLAB_BOT_USERNAME`   | empty: the organization token's user                            |
| `gitlab.bot.rateLimit` | `OPTIO_GITLAB_BOT_RATE_LIMIT` | `5` per person per merge request or issue in 10 minutes (1–100) |

On GitHub the bot is the **GitHub App's** (people mention its slug,
`@<slug>`; its comments are `<slug>[bot]`'s), or a machine user named with
`github.bot.username` / `OPTIO_GITHUB_BOT_USERNAME`. Without either Optio
doesn't answer: GitHub doesn't say whether a token's user is a person, so a
personal token's user is never the bot on its own. The App's webhook (or
the repository webhook Optio registers when `OPTIO_REPO_WEBHOOKS` names
GitHub) must send **Issue comments** to `/api/webhooks/github`. Optio reacts
with `eyes`, replies on the issue or pull request with the organization's
GitHub token (the App's installation token, else `GITHUB_TOKEN`), and needs
the commenter to have **write** access to the repository.

| Helm value             | Environment                   | Default                  |
| ---------------------- | ----------------------------- | ------------------------ |
| `github.bot.enabled`   | `OPTIO_GITHUB_BOT_ENABLED`    | `false`                  |
| `github.bot.username`  | `OPTIO_GITHUB_BOT_USERNAME`   | empty: the GitHub App's  |
| `github.bot.rateLimit` | `OPTIO_GITHUB_BOT_RATE_LIMIT` | `5`, as GitLab's (1–100) |

The settings API is `/api/github-bot` beside `/api/gitlab-bot`, the same
shape.

Optio matches by username only when GitLab shows the bot's token no email
for the commenter (no public email, and the organization token isn't a
GitLab admin's), and that assumes GitLab and Optio sign people in through
the same directory, so a GitLab username is the same person's Optio
sign-in name. A GitLab account whose email Optio can read is matched by
that email alone, so a local account named like a directory user but
registered with another address is refused. If your GitLab has local
accounts whose names could collide with directory names, have people set
their directory email as their public email in GitLab, or turn the bot off.

## How it relates to the GitLab "mentioned" trigger

They are separate and both keep working:

- The **bot** (this page) answers mentions of **one shared GitLab user**,
  works as **whoever wrote the comment**, and replies in the thread. Nobody
  sets anything up per person or per project.
- A **GitLab event trigger** with the kind `mentioned` (on a Job, a scheduled
  Task or a Local automation; [tasks.md](tasks.md)) fires when **a person's
  own username** (the trigger's `username`) is mentioned, runs **the
  trigger's work as its owner**, and doesn't reply.

Don't make a `mentioned` trigger for the bot's own username: both would act
on the same comment.

## Troubleshooting

- **No eyes, no reply.** Check the project's webhook in GitLab (Settings →
  Webhooks → Edit → Recent events: a 200 from Optio), that the repo is in
  Optio and that its host is in `gitlab.hosts` (or is the setup wizard's). Settings → Integrations → GitLab bot says whether Optio knows the
  bot's name on that host; "couldn't tell who its GitLab user is" means the
  organization's GitLab token is missing or refused (Settings → System
  health, [credential-health.md](credential-health.md)).
- **Eyes, but no reply.** The token's user may not comment there: GitLab
  answered Optio's reply with an error, which the API log names
  (`GitLab mention: could not reply in the thread`).
- **"I can't find you in Optio" for someone who has an account.** GitLab
  redacts emails in webhooks, so Optio asks GitLab for the person's profile:
  an admin's token reads their email, any other token only their public
  email. If the reply says "the email your GitLab profile gives", that email
  isn't the one their Optio account has: correct it in GitLab (or their
  public email). If it says GitLab doesn't show their email, their GitLab
  username must equal their Optio sign-in name.

## For developers

| Piece                                                        | File                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| The receivers' hooks (one line each, store the comment)      | `apps/api/src/routes/event-ingress.ts`, `routes/tickets.ts` → `services/gitlab-bot/ingress.ts`   |
| Parsing a comment (`fix pipeline`, `team:`, code and quotes) | `services/gitlab-bot/commands.ts`                                                                |
| Who, may they, what to do                                    | `services/gitlab-bot/process.ts`                                                                 |
| The person from an email or username                         | `services/person-lookup.ts`                                                                      |
| The bot's name, settings, platform calls                     | `services/gitlab-bot/settings.ts`, `bot-cache.ts`, `thread.ts`, `gitlab-api.ts`, `github-api.ts` |
| Words of the replies and prompts                             | `services/gitlab-bot/replies.ts`, `prompts.ts`, `words.ts`                                       |
| The result in the thread (hook in `task-service.ts`)         | `services/gitlab-bot/outcome.ts`                                                                 |
| Settings route and card                                      | `routes/gitlab-bot.ts`; web `components/settings/gitlab-bot-settings.tsx`                        |
| Table                                                        | `gitlab_mentions` (`1792770000_gitlab_mentions.sql`)                                             |

A stored comment is handled after the receiver answers GitLab; a row an API
instance left half done (`received` for two minutes, `processing` for five)
is picked up with the next delivery. Handled rows are kept 90 days (ignored
ones a day). Tests: `services/gitlab-bot/*.test.ts` (unit),
`services/gitlab-bot/gitlab-bot.int.test.ts` (signed deliveries against a
fake GitLab, `test-utils/fake-gitlab.ts`), and
`services/gitlab-bot/github-mentions.int.test.ts` (GitHub comments against a
fake GitHub API).
