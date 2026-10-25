# Using Optio

This guide is for developers who use Optio day to day. You describe a change,
an agent makes it on a branch of your GitLab project and opens a merge
request, and you review it and merge it. Admins set Optio up
([options.md](options.md)); this page is what you do.

The same guide is in the app, with the getting-started checklist below, when
a deployment admin turns on **Settings → Access → Getting-started guide**
(`OPTIO_ONBOARDING`, chart `onboarding.enabled`; off by default): **Help →
Using Optio** in the account menu at the bottom of the sidebar.

- [Your first day](#your-first-day)
- [Sign in](#sign-in)
- [Your gateway token](#your-gateway-token)
- [Start work](#start-work)
- [Team or personal work](#team-or-personal-work)
- [Follow a run](#follow-a-run)
- [Waiting for you](#waiting-for-you)
- [Review the merge request](#review-the-merge-request)
- [Merge automatically](#merge-automatically)
- [Notifications](#notifications)
- [Remote workspaces](#remote-workspaces)
- [Your own agent](#your-own-agent)
- [What admins can see](#what-admins-can-see)
- [When something goes wrong](#when-something-goes-wrong)

## Your first day

With the getting-started guide on, the **Overview** shows a **Getting
started** checklist until you have done each step. Every step reads the real
state and links to where it is done; the gateway token step shows only where
there is a gateway, the team step only with teams on, and it says pull or
merge request by your repositories' platform:

| Step                            | Done when                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| Sign in                         | Always (you're signed in)                                                                       |
| Gateway token                   | Your own token is stored and the gateway doesn't refuse it (or the gateway uses a shared token) |
| Join your team (optional)       | You are a member of a team                                                                      |
| A repository to work on         | The workspace has a repository                                                                  |
| Start your first task           | You started a task on a repository                                                              |
| Review your first merge request | A task you started was merged                                                                   |
| Notifications                   | Email can reach you with at least one email on, or your own chat hook is on with an event on    |

**Hide** puts the checklist away for you in this browser; **Help →
Getting-started checklist** in the account menu brings it back. It goes away
by itself once every step is done (until Optio has checked your token, it
looks again on your next visit). A viewer, who can't start work, sees only
the steps that apply.

## Sign in

Open Optio's address. The sign-in page offers what your organization set up:

- **Sign in with Google, GitHub or GitLab**: your account there, then back
  to Optio.
- **Sign in with …** (single sign-on): your organization's identity
  provider, then back to Optio.
- **A username and password form** (the directory, LDAP or Active
  Directory): your directory account. A wrong username and a wrong password
  get the same answer, "Wrong username or password".

The first time you sign in through single sign-on or the directory you join
the organization's workspace (when the admins turned that on), and your
directory groups put you in the teams mapped to them. If the page says "Your account isn't in a group allowed to
use Optio" or "Your Optio account is disabled", ask an Optio admin.

**The command line.** Optio serves its own CLI (Node 20 or newer):

```sh
curl -fsSL https://optio.example.com/api/cli/install.sh | sh
optio login --server https://optio.example.com                  # the first sign-in offered, in a browser
optio login --server https://optio.example.com --provider ldap  # the directory, asks for your password
```

## Your gateway token

Agents reach their models only through your organization's **model gateway**
(LiteLLM, OpenRouter, Portkey or another compatible endpoint). Every run
carries a gateway token, and **your own work runs on
your own token**: there is no fallback to anyone else's, so the gateway's
spend stays per person. Without one, a run of yours fails with
`Add your gateway token under Settings → My tokens`.

**Settings → My tokens** shows whether you have one ("Stored" or "No token
yet") and lets you add it, as your admins allow:

- **Get my token**: Optio makes your own key in the gateway, with the budget
  and expiry the admins chose, and stores it. **Rotate** makes a new one
  (it keeps what the old one spent this budget period); **Give up** deletes
  it.
- **Paste your token** and **Save**: a key you got from the gateway yourself.
  Optio tries it at once and says "Token saved", or "Token saved, but the
  gateway refused it".

Optio checks every token on a schedule. **Settings → My tokens → Health**
shows yours, and **Check my tokens** checks them now. You get an email 30, 7
and 1 days before your token expires, when the gateway refuses it, and when
it has spent its budget (a key Optio made for you also warns at 80%). Before
each run, Optio asks the gateway about the run's token and fails the run at
once, saying why, when the gateway would refuse it.

Which token a run uses depends on whose work it is
([below](#team-or-personal-work)):

| The work is        | It runs on                                                                 |
| ------------------ | -------------------------------------------------------------------------- |
| Yours (Private)    | Your token (Settings → My tokens)                                          |
| A team's           | The team's token; a team admin adds it under **Teams → the team → Tokens** |
| The organization's | The organization's token; an admin adds it under Settings → Model gateway  |

Your own **GitLab token** (Settings → My tokens) is optional: your work uses
it instead of the organization's for GitLab.

## Start work

### From New work

**New work** (on the Overview, or `/work/new`) asks five things:

- **When**: now, on a schedule, or on a trigger.
- **Where**: an **Optio pod**, **My machine** (a computer you paired) or **A
  remote workspace** ([below](#remote-workspaces)). For work on a repository,
  pick the repository and **Start from** a branch, or **An open merge
  request**: the agent branches off that merge request's branch and opens a
  merge request back into it.
- **Who**: the agent, and the model from your gateway's catalog.
- **What**: the prompt, written by you or taken from a saved prompt.
- **Then**: **Exit when done** (one run), **Work until merged** (opens a
  merge request, then comes back to fix failing CI, conflicts and review
  feedback until it merges), **Wait for me** (stops at its prompt after
  each turn until you type) or **Persistent agent**.

The **Owner** row is in Where ([below](#team-or-personal-work)).

### From a Jira ticket

If your team (or the organization, or you) connected Jira under **Settings →
Integrations → Tickets**, a ticket becomes work when it has two labels:

- the provider's label, `optio` unless your admins chose another;
- `repo:<group>/<project>`, the GitLab project the change is for (for example
  `repo:platform/hello-service`).

Optio reads Jira every minute by default and starts the work; a ticket that is
done is left alone. (The first time a connection is read, the tickets already
there wait on their task's page until someone presses **Start**.) The work
belongs to whoever owns the Jira connection, so a team's Jira fills the team's
work. When the connection's **Round trip** is on,
the ticket hears how it goes: a comment with the link to the run, then the
merge request, when it merges or fails, and a link on the ticket. **A new
comment on the ticket** resumes work that is waiting for you, with your
comment as the next instruction. A ticket whose `repo:` label matches no
repository gets one comment saying which label to add.

The merge request is titled with the ticket's key (`PLAT-1: …`), so GitLab
links them.

### From a GitLab issue

- **Inbox** (in the sidebar) lists the open issues of the repositories in
  Optio, and the tickets of your ticket connections. **Assign to Optio**
  starts a task from a GitLab issue (Jira tickets come in by themselves).
- A **GitLab Issues** connection under Settings → Integrations → Tickets
  picks up the project's issues labelled `optio` by itself.

### With @optio in a GitLab comment

Mention Optio's GitLab user (**Settings → Integrations → GitLab bot** shows
its name) in a comment on an issue or a merge request:

```text
@optio-bot add a line to the README saying how to run the tests
@optio-bot fix pipeline
@optio-bot team:platform bump the base image to the new release
```

| Where you comment                 | What Optio does                                                             |
| --------------------------------- | --------------------------------------------------------------------------- |
| An issue                          | Starts work from the issue; its merge request says `Closes #<issue>`        |
| A merge request Optio opened      | Resumes that work with your comment; it pushes to the same branch           |
| Someone else's merge request      | Opens a merge request **into that branch**; it never pushes to their branch |
| `fix pipeline` on a merge request | Hands the failed jobs' logs to the agent to fix                             |

Optio adds an "eyes" award to your comment, replies with a link to the run,
and replies again with the result. The work is **yours** (your Optio account
is found by your email), or the team's with `team:<team>`, and runs on your
gateway token. If it can't act it says why in the thread, for example "I
can't find you in Optio" (sign in to Optio once first) or "Add your gateway
token under Settings → My tokens".

## Team or personal work

Every piece of work in a pod has an **Owner** (in Where, on New work):

| Owner                        | Uses                                                                               | Who sees it                               |
| ---------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------- |
| **Private**                  | Your own secrets, connections and gateway token                                    | You (and workspace admins)                |
| **Team** (pick one of yours) | The team's gateway token; the team's secrets, then the organization's; never yours | The team's members (and workspace admins) |
| **Organization**             | The organization's secrets, connections and gateway token                          | Depends on the workspace (below)          |

Work on your own machine is always yours.

Who sees whose work is set per workspace. With **teams** (the usual setting
here) you see your own work, your teams' work, and work you started; other
people's private work and other teams' work stay out of your lists, and a
link to it answers "not found". With **organization** everyone sees the
organization's work. Workspace admins see everything.

Teams are on the **Teams** page: join an open team at once, ask to join one
that takes requests, or create one (you become its admin). A team's admins
add its gateway token and GitLab token under **Teams → the team → Tokens**.

## Follow a run

- **Work** (the sidebar) lists everything you may see: **Active**,
  **Recurring**, **Agents** and **History**.
- The **Overview** shows what is running, what is waiting for you, and what
  needs you.
- A task's page (`/work/<id>`) streams the agent's log as it works, shows the
  merge request when there is one, and the agent policy the run started with
  (what the agent may not do, and where each rule came from). While a Claude
  Code task runs you can **Send** it a message, or **Stop** it.
  **Cancel task**, **Retry** and **Start** (a ticket's task waiting to be
  started) are at the top.

A failed run says why in words that name the fix, for example
`Add your gateway token under Settings → My tokens`.

## Waiting for you

A task that reads **MR** (**PR** on GitHub) is waiting for you: the agent is
done, it opened its merge request and a person reviews and merges it.
Nothing is stuck. Answer it in one of these ways:

- **Merge it**, in GitLab (the work then completes by itself) or with
  **Approve & merge** on the **Reviews** page.
- **Ask for changes**:
  - in GitLab, as a review or a comment; with **Work until merged**, the
    agent comes back for review feedback, failing CI and conflicts;
  - with `@optio-bot <what to change>` in a comment on the merge request;
  - on the task's page: type into **Resume the agent with a message...** and
    press **Resume**;
  - for work from Jira, with a comment on the ticket.
- **Close** the merge request if you don't want the change: the work fails
  with it.

**Needs attention** is different: the work stopped and needs you, for
example "PR checks need attention", "PR has merge conflicts", "PR review
requested changes", or a plan waiting for your review. The task's page says
which, and the same message box resumes it.

## Review the merge request

Optio's merge request is on its own branch (`optio/task-<id>`) and tells you
where it came from:

- the title starts with the Jira key for work from a ticket (`PLAT-1: …`);
- the description ends with the ticket, who asked, the team and a link to
  the run;
- every commit ends with trailers: `Co-authored-by` (who asked) and
  `Optio-Run` (the run), plus `Jira:` and `Optio-Team:` when they apply.

When the repository has automatic code review on (its admins set it, on CI
passing or when the merge request opens, thorough or light), Optio's review
agent reviews the merge request too. The **Reviews** page lists open merge
requests; **Review with Optio** asks the review agent to review one. Review it
like any colleague's merge request.

## Merge automatically

Nothing merges by itself unless a person said so twice:

1. On New work, with **Then: Work until merged**, tick **Merge it for me
   when it's ready**.
2. A dialog asks **Merge automatically?** Only **Yes, merge automatically**
   turns it on.

Optio then merges the merge request when CI passes and no reviewer
requested changes. It waits while CI runs or fails, while the merge request
is a draft or has conflicts, and never merges over a reviewer who asked for
changes. Untick the box to merge by hand again. Saved work shows when it was
confirmed ("Confirmed on <date>") under the box when you open it again, and
the audit trail records who confirmed it.

An agent can never turn this on or merge by itself. If GitLab keeps refusing
the merge for about five minutes, the task comes back to you with GitLab's
reason.

## Notifications

Optio emails you, through your organization's mail relay, at the address your
sign-in gave it:

| Event                                         | Emailed by default |
| --------------------------------------------- | ------------------ |
| Merge request waiting for you                 | yes                |
| Needs attention                               | yes                |
| Failed                                        | yes                |
| Merged                                        | no                 |
| Your token expiring, refused or out of budget | yes                |

You get the email for your own work (for the organization's work, the person
who started it does), and as a team admin for your team's work. **Settings → Notifications → What reaches you** has an **Email** switch
for each event and, for team admins, **Your teams' work too**. Each switch
saves at once.

**Your own chat hook.** **Settings → Notifications → Your chat hook** takes
an incoming webhook into a channel of your own (or a direct message to
yourself) in Discord, Google Chat, Mattermost, Microsoft Teams, Rocket.Chat,
Slack, Webex or Zulip, and the **Chat** column switches each event for it. **Send test** posts "Optio can post here". This works without
email too, for example when your sign-in gave Optio no address.

**Your team's channel.** A team's admins set one under **Teams → the team →
Team channel**: it posts about the team's own work (never a member's own
work), in addition to what each person chose.

**A daily digest.** **Settings → Notifications → Daily digest** sends one
message a day, at the hour you pick, with what waits for you, what failed and
what merged since the last one, by email, your chat hook or both. **Send me
one now** sends the last 24 hours at once.

A post or an email that didn't go out is tried again; the details are in
[notifications.md](notifications.md).

**Webhooks.** An outbound webhook can also post to a chat channel: the
**Webhooks** page (`/webhooks`; admins find it in the account menu) → New,
paste the channel's incoming webhook URL and pick the **Body format** (the
chat service; **By the URL** recognises a Discord, Google Chat or Webex URL,
among others). The channel's host must be one
your admins allow. A webhook receives events only for work its creator may
see.

GitLab and Jira tell you too: Optio's replies in a GitLab thread start with
your `@name`, and a ticket's comments are Jira's notifications.

## Remote workspaces

To run an agent in a development workspace — a Coder workspace, a GitHub
codespace, a Daytona or E2B sandbox — pick **Where → A remote workspace** on
New work, then the connection and a new or an existing workspace. Optio
starts the workspace, the workspace pairs itself with Optio, the agent works
on a branch in its checkout and opens the merge request. When the work is
done Optio stops (or deletes) the workspace; a re-run or a resume starts it
again. A workspace that doesn't come up within 15 minutes fails the run with
the reason.

A connection is the organization's, your team's, or your own: **Settings →
Integrations → Remote workspaces** takes your own provider and token if you
want workspaces under your own account there.

## Your own agent

**Settings → Access → Connect your agent** lets the Claude Code (or OpenCode,
or any MCP client) on your computer create and run work in Optio. Pick the
client, press **Create a token for this agent**, and copy what it shows. For
Claude Code:

```sh
claude mcp add --transport http optio https://optio.example.com/api/mcp \
  --header "Authorization: Bearer optio_pat_REPLACE_ME" \
  --header "X-Workspace-Id: YOUR_WORKSPACE_UUID"
```

Your agent can then create work (now, on a schedule or on a webhook), run it,
read its runs and logs, manage triggers and prompts, and message the agents
Optio runs, with your permissions; a viewer's agent only reads. It has to run
inside your organization's network. For a client that speaks only stdio, the
card's **Other (stdio)** tab downloads `optio-controller-mcp.js`. The token
is one of your API keys: revoke it under Settings → Access → API keys.

## What admins can see

- **Your work.** Workspace admins see every piece of work in the workspace,
  your private work included.
- **The audit trail.** Optio records sign-ins (and refused ones),
  sign-outs, API keys, tokens being set or removed, team and workspace
  membership, every merge (and who confirmed an automatic one), settings
  changes and GitLab mentions, with the address the request came from. It
  never records a secret, a token, a password, a prompt or a request body.
  Workspace admins read their workspace's entries on the **Audit** page;
  deployment admins read every workspace's. You can't read it; your
  **Activity** feed leaves those entries out.
- **Usage.** **Insights → Usage** ranks people's and the organization's
  usage; members see the totals, and only you and workspace admins see your
  private runs' titles. The gateway counts spend per token, so a key Optio
  made for you shows its budget under Settings → My tokens.
- **Agent policy.** The rules every agent run gets (what it may not read or
  run) are on Workspace settings → Agent policy, a team's page and a
  repository's page; each run's page shows the ones it started with.

## When something goes wrong

| You see                                                                      | Do this                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `Add your gateway token under Settings → My tokens`                          | Add it ([Your gateway token](#your-gateway-token))                             |
| `This team has no gateway token yet — a team admin adds one under Teams → …` | Ask the team's admins, or make the work yours                                  |
| `The organization has no gateway token — an admin adds one …`                | Ask an admin, or make the work yours or your team's                            |
| `Your gateway token is over budget until …`                                  | Wait for the reset, or ask whoever set the budget                              |
| `… gateway token was rejected by the gateway …`                              | Get or paste a new token under Settings → My tokens                            |
| `… takes only keys Optio makes: press "Get my token" …`                      | Press **Get my token** instead of pasting                                      |
| `Automatic merging needs the checkbox and the confirmation`                  | Tick the box and accept the dialog                                             |
| A Jira ticket gets "Optio can't work on this ticket …"                       | Add or fix its `repo:<group>/<project>` label, or ask an admin to add the repo |
| GitLab: "I can't find you in Optio"                                          | Sign in to Optio once with the email GitLab shows, then mention it again       |
| The task waits on "MR" for days                                              | That's you: [review and merge, or ask for changes](#waiting-for-you)           |

Anything else: your Optio admins have the common failures and their fixes
([observability.md](observability.md#common-failures)).
