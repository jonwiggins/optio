# @-mentions in GitHub and GitLab comments

Mention Optio's bot in a comment on an issue, a merge request (GitLab) or a
pull request (GitHub) and Optio works for you, as you, and answers in the
same thread. It is **off by default** on both platforms until a deployment
admin turns it on (below). The examples say merge request; on GitHub the
same works on pull requests:

```text
@optio-bot add a line to the README saying how to run the tests
@optio-bot help
```

| Where you comment                    | What Optio does                                                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An **issue**                         | Starts work in that project from the issue: its title and description and your comment. The agent opens a merge request that says `Closes #<issue>`.                                |
| A merge request **Optio opened**     | Resumes that work with your comment as the next instruction: the agent changes the code on the same branch and pushes; no new merge request.                                        |
| **Anyone else's** merge request      | Starts work from the merge request's source branch. The change comes as a new merge request **into that branch**, so its author can take it in; Optio never pushes to their branch. |
| `help`, or just the mention on an MR | Answers with what it can do.                                                                                                                                                        |

What follows the mention is the instruction; the rest of the comment (code
blocks included) goes to the agent as you wrote it. A mention inside code
(`` `@optio-bot` `` or a fenced block) or in a quoted line (`> …`) doesn't
count, so quoting an earlier request never starts it again.

## What you see

1. An **eyes** reaction on your comment: Optio saw it.
2. A **reply in your thread** with a link to the run in Optio (`/work/<id>`),
   or the reason it won't act.
3. When the run ends, **one more reply** with the result: the merge request
   it opened, that it pushed the changes, the reason it needs a person, why it
   failed, or that it was cancelled. Secret-looking text in a reason is masked.

The replies start with `@you`, so the platform notifies you, and never name
the bot, so a reply can't start another run.

## Who Optio works as

The run is **yours**, found in this order:

1. The Optio account that **signs in with that same GitHub or GitLab user**
   (GitHub sign-in for github.com; GitLab sign-in for the GitLab at
   `GITLAB_OAUTH_BASE_URL`, when that is where you commented).
2. Else the **one** Optio account whose **verified** email is your **public**
   GitHub email, or your public GitLab email on the GitLab sign-in uses
   (`GITLAB_OAUTH_BASE_URL`). Not when that account already signs in with
   another user of the same service, and not when two accounts share the
   email.

Both steps need the GitLab that Optio signs people in with: on any other
GitLab the bot can't tell who a commenter is and answers with how to link
an account. A self-managed GitLab with email confirmation off lets anyone
show any address as their public email, so only the sign-in GitLab's
emails are trusted.

A username or display name never decides who you are: anyone can pick one.
If neither step finds you, Optio says how to link your account.

New work is your own (private) work and shows up in your Work list like
work you started in Optio. Resuming Optio's own merge request keeps that
work's owner: you may do it when Optio's Resume button would let you.

Optio answers in the thread instead of acting when: it can't tell which
account is yours (or two accounts match); you aren't a member of a workspace
that has the repo, or only a viewer there; your role on the project is below
Developer (GitLab) or write (GitHub); the merge request is someone else's
private work, closed, merged or from a fork; its run is still going; or you
asked too often (below). An unexpected error's reply names only a reference
(the mention's id), which an admin finds in the API log (`GitLab mention:
failed`).

Each outcome goes to the action log: `gitlab_mention.start`,
`gitlab_mention.resume` and `gitlab_mention.refuse` (the reason as its
status), with the repo and the run. A refusal for someone with no Optio
account belongs to no workspace, so deployment admins see it.

## Limits

- **Once per comment**, however many times it is delivered (a retry, a
  redelivery, a project hook and a group hook): Optio keeps the host and
  comment id. An edited comment isn't a new request.
- **Rate limit**: at most 5 requests (Settings, below) from one person per
  merge request or issue in 10 minutes; their next ones get one "That's a lot
  of requests" reply. Each person has their own budget.
- **The bot's own comments** and other bots' are never read as requests.
- **Projects Optio knows, on named hosts**: the project must be a repo in
  Optio; on GitLab its host must be one the deployment named (`GITLAB_HOSTS`
  / `OPTIO_GITLAB_HOSTS`, or the setup wizard's `GITLAB_HOST`; gitlab.com
  when none is named). A comment anywhere else is ignored without a reply:
  the organization's token never goes to a host only a repo names.
- **Offered platforms**: a platform the deployment leaves out of
  `OPTIO_GIT_PLATFORMS` gets no bot.
- **One run at a time** per merge request Optio opened.

## For admins: setting it up

Turn the bot on per platform under **Settings → Integrations** (deployment
admins), or with the environment; the saved choice wins, and "Follow the
deployment" removes it. While it is off, the receivers don't even store
comments.

| Environment                   | Default                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `OPTIO_GITLAB_BOT_ENABLED`    | `false`                                                     |
| `OPTIO_GITLAB_BOT_USERNAME`   | empty: the organization GitLab token's user, if it is a bot |
| `OPTIO_GITLAB_BOT_RATE_LIMIT` | `5` per person per merge request or issue in 10 minutes     |
| `OPTIO_GITHUB_BOT_ENABLED`    | `false`                                                     |
| `OPTIO_GITHUB_BOT_USERNAME`   | empty: the GitHub App's bot                                 |
| `OPTIO_GITHUB_BOT_RATE_LIMIT` | `5`                                                         |

**GitLab.** The bot is the organization's GitLab token's own user, and it
must be a **bot or service account** (a project or group access token's bot
user, or a service account). Optio asks GitLab who the token is (`GET /user`)
and answers only when GitLab says `bot: true`; a person's token, or a GitLab
that doesn't say, means the bot doesn't answer at all, so mentioning a person
never starts work. Name a user explicitly only if that account really is
meant to be the bot. The project's webhook must send **Comments** to
`/api/webhooks/gitlab`; the token's user must be able to comment and read
members on the project.

**GitHub.** The bot is the **GitHub App's** (people mention its slug,
`@<slug>`; its comments are `<slug>[bot]`'s), or a machine user an admin
names. Without either Optio doesn't answer: GitHub doesn't say whether a
token's user is a person, so a personal token's user is never the bot on its
own. The webhook must send **Issue comments** to `/api/webhooks/github`.

**`PUBLIC_URL`** makes the replies link to the run; without it they name the
run's id. The settings API is `/api/gitlab-bot` and `/api/github-bot`
(anyone signed in reads whom to mention; deployment admins change it).

## How it relates to the GitLab "mentioned" trigger

A **GitLab event trigger** with the kind `mentioned` ([tasks.md](tasks.md))
fires when a person's own username is mentioned, runs the trigger's work as
its owner, and doesn't reply. The bot answers mentions of one shared bot
user and works as whoever wrote the comment. Don't make a `mentioned`
trigger for the bot's own username: both would act on the same comment.

## For developers

| Piece                                                 | File                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| The receivers' hooks (store the comment)              | `apps/api/src/routes/event-ingress.ts`, `routes/tickets.ts` → `services/gitlab-bot/ingress.ts`   |
| Parsing a comment (code and quotes)                   | `services/gitlab-bot/commands.ts`                                                                |
| Who, may they, what to do                             | `services/gitlab-bot/process.ts`                                                                 |
| The person from a linked identity or a verified email | `services/person-lookup.ts`                                                                      |
| The bot's name, settings, platform calls              | `services/gitlab-bot/settings.ts`, `bot-cache.ts`, `thread.ts`, `gitlab-api.ts`, `github-api.ts` |
| Words of the replies and prompts                      | `services/gitlab-bot/replies.ts`, `prompts.ts`, `words.ts`, `mask.ts`                            |
| The result in the thread (hook in `task-service.ts`)  | `services/gitlab-bot/outcome.ts`                                                                 |
| Settings route and card                               | `routes/gitlab-bot.ts`; web `components/settings/gitlab-bot-settings.tsx`                        |
| Table                                                 | `gitlab_mentions` (`1794725000_mentions.sql`)                                                    |

Platform calls go through the outbound guard (`guardedFetch`, no redirects).
A stored comment is handled after the receiver answers; a row an API
instance left half done (`received` for two minutes, `processing` for five)
is picked up with the next delivery. Handled rows are kept 90 days (ignored
ones a day). Tests: `services/gitlab-bot/*.test.ts` (unit),
`gitlab-bot.int.test.ts` (signed GitLab deliveries against a fake GitLab,
`test-utils/fake-gitlab-bot.ts`) and `github-mentions.int.test.ts` (GitHub
comments against a fake GitHub API).
