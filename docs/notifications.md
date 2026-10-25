# Chat and email notifications

Optio tells people when their work needs them: by **email** through an SMTP
relay, on **each person's own chat hook**, in **a team's channel**, in an
optional **daily digest**, and through **outbound webhooks**. A chat hook or
webhook can be any of the chat services in [Chat services](#chat-services) —
Discord, Google Chat, Mattermost, Microsoft Teams, Rocket.Chat, Slack, Webex
or Zulip — each getting the message in its own format; an outbound webhook
can also send Optio's JSON to a receiver of your own. Each person chooses
which events reach them, and how. Every email and chat post goes through a
queue that retries while the relay or the chat is down
([When the relay is down](#when-the-relay-is-down-retries-and-undelivered)).

All of it is off until it is set up: email once an admin gives Optio a
relay, chat once someone saves a hook or a webhook. Email and chat need only
the relay and the chat servers to be reachable from the API (the outbound
policy, `outbound.allowedHosts`). Browser push (VAPID) and the phone apps'
push (APNs, FCM) still work where they are configured; they go through the
browser vendors' and Apple's or Google's services.

## What people get by email

| Event                             | When                                                                                          | Emailed by default |
| --------------------------------- | --------------------------------------------------------------------------------------------- | ------------------ |
| **Merge request waiting for you** | Work opened its merge request and waits for its owner to review and merge it (`pr_opened`)    | yes                |
| **Needs attention**               | Work stopped and needs a person: changes were asked for, CI keeps failing (`needs_attention`) | yes                |
| **Failed**                        | A Task failed, or a run of a Job failed for good (its retries used up)                        | yes                |
| **Merged**                        | A Task's merge request was merged and the work completed                                      | no                 |
| **Someone left**                  | To workspace and team admins: someone was disabled ([directory-sync.md](directory-sync.md))   | yes                |
| **Directory sync stopped**        | To deployment admins: the directory sync started holding or failing, so it changes nobody     | yes                |
| **Gateway budget almost spent**   | A gateway key Optio made has used 80% of its budget (`budget.warning`)                        | yes                |
| **Gateway budget used up**        | It used the whole budget: the gateway refuses its runs until it resets (`budget.exceeded`)    | yes                |

Optio also emails the owner of a token before it expires and when it stops
working or spends its gateway budget (**Token expiring**, **Token refused**,
**Gateway budget used up**; [credential-health.md](credential-health.md)).
Every kind in this table reaches a person's own chat hook too, as they
choose ([Your own chat hook](#your-own-chat-hook)).

An email names the work, its repository and merge request, says what went
wrong when it failed, and links to the work's page in Optio (a Task at
`/work/<id>`, a Job run at `/jobs/<job>/runs/<run>`, under `PUBLIC_URL`). Its
last lines say why the person got it and link to Settings → Notifications.
Code-review subtasks send nothing of their own. A Job run is news only when
it fails for the last time: an attempt that the Job's retries (**Max
retries**) will run again sends nothing, and neither does a run someone
cancelled.

The two gateway budget emails are about a key, not a piece of work
([model-gateway.md](model-gateway.md#keys-optio-makes) "Budget warnings"):
a person's key goes to its owner, a team's to the team's admins, each once
per budget period. They say what was spent of what, when the budget resets,
and link to Settings → My tokens or the team's page.

### Who gets it

- **The work's owner.** For the organization's work, which has no owner,
  the person who started it.
- **For a team's work, the team's admins** as well (active members with the
  admin role).
- **Only people who may see the work** now, by the same rule the Work list
  follows (`canSeeWork`: their own teams, their role, the workspace's work
  visibility, docs/teams.md), and who are still members of its workspace.
  Someone who left the workspace, or a team admin who stepped down, gets
  nothing.

The address is the one the person's sign-in gave Optio (the OIDC `email`
claim, or the LDAP email attribute, `mail` by default). Each person gets
their own message; recipients never see each other.

## Choosing what reaches you

**Settings → Notifications → What reaches you**: one row per event, with an
**Email** switch, and a **Chat** switch once you saved your own chat hook
(below; it starts from the same defaults as email). A team admin also sees
**Your teams' work too**: off, they hear about their own work only, on any
channel. Each switch saves at once. Viewers have the same choices for
themselves. Push, where this Optio has it, keeps its own card below
(**Browser Push Notifications**): its per-event switches show once the
browser is subscribed.

The choices are kept per person, so they follow you across workspaces. Over
the API: `GET /api/notifications/channels` and
`PUT /api/notifications/channels` with
`{ "email": { "task.failed": false }, "chat": { "task.completed": true }, "push": { … }, "teamWork": false, "digest": { "enabled": true, "hour": 8, "timeZone": "Europe/Berlin", "via": "email" } }`
(only what changes).

## Your own chat hook

**Settings → Notifications → Your chat hook**: an incoming webhook into a
channel of your own (or a direct message to yourself) in any of the
[chat services](#chat-services). Optio posts there what you switch on in the
**Chat** column, and your digest when you pick chat for it. Each service's
section says where to make the hook. No chat is chosen at first: pasting a
URL only one service uses (a Discord, Google Chat or Webex address, among
others) picks its chat; for a URL any server could have, pick the chat
yourself (until you do, Save and Send test answer "Choose the chat").

- **Send test** posts "Optio can post here" at once, to the saved hook or
  to the URL in the box before you save it. When the chat refuses it you
  see the HTTP status and what it means ("HTTP 404: it has no such hook"),
  never the text the chat answered; the API log has that
  (`notify: the chat refused a post`).
- Everyone signed in can set their own hook, viewers too: it carries only
  what they may see. A hook can point at any host the deployment's outbound
  policy allows (`outbound.allowedHosts`, the same list outbound webhooks
  use), so keep that list to the chat servers and the services Optio
  needs. Optio posts only its fixed message bodies there, follows no
  redirects, and shows back a refusal's status, never its text.
- The URL lets anyone who has it post to your channel, so Optio seals it
  (AES-256-GCM, like a secret) and shows it back only as a hint
  (`https://chat.example.com/hooks/…a1b2`). Paste a new one to replace it.
- A post that didn't arrive shows under the card ("The last post didn't
  arrive: …"); it is retried like email.
- Bodies are the chat service's own ([Chat services](#chat-services)); a
  work event looks as it does on an outbound webhook of that format. A
  notice (a token, a budget, someone who left) has its subject, its text and
  an **Open in Optio** link. Anyone's text in them shows as written.
- Someone whose sign-in gave no email address can still be reached here.
- Over the API: `GET` (the hook, and `formats`), `PUT`
  (`{ "url", "format" }`: `format` is one of `discord`, `googlechat`,
  `mattermost`, `msteams`, `rocketchat`, `slack`, `webex`, `zulip`; left out,
  it is the one the URL can only be, else the saved one, else a 400; an
  empty URL keeps the saved one), `DELETE /api/notifications/chat-hook`,
  `POST /api/notifications/chat-hook/test` (`{ "url", "format" }`, both
  optional: a URL given is posted to in the format chosen the same way; no
  URL tests the saved hook).

## A team's channel

**Teams → the team → Team channel**, for the team's admins and workspace
admins: an incoming webhook of any of the [chat services](#chat-services)
into the team's channel, and which events it posts.

| Event                                                         | Posted by default                         |
| ------------------------------------------------------------- | ----------------------------------------- |
| Merge request waiting, Needs attention, Failed, Merged        | yes — about **the team's own work**       |
| Gateway budget almost spent / used up, Token expiring/refused | no — the team's key and tokens, if ticked |

- **Only the team's own work** (work whose owner is the team): never a
  member's own work, nor another team's, whatever the workspace's work
  visibility. Everyone in the team may see the team's work, so the channel
  shows nothing a member couldn't open in Optio; who reads the chat channel
  is the chat's business, so point it at a channel of the team.
- The people still get their own email and chat as they chose: the channel
  is in addition.
- A team of another workspace is a 404; a member who isn't the team's admin
  gets a 403, and nothing changes. Saves and removals are in the audit trail
  (`team.chat_channel.set` / `.delete`).
- Over the API: `GET`, `PUT` (`{ "url", "format", "events": [...] | null, "enabled" }`),
  `DELETE /api/teams/:id/chat-channel`, `POST /api/teams/:id/chat-channel/test`.

## The daily digest

**Settings → Notifications → Daily digest**: once a day, at the hour you
pick in your time zone (this browser's when you first turn it on), one
message with:

- **Waiting for you**: your merge requests waiting for review, and work
  that needs you (now, whenever it started);
- **Failed**: what failed since your last digest (a Job run once, at its
  last try; a cancel isn't a failure);
- **Merged**: what merged since your last digest.

It covers what one event at a time would tell you about: your own work
(a team's work you created included), the organization's work you started,
and — unless **Your teams' work too** is off — the work of the teams you
administer; only what you may see now, in every workspace you belong to.
Each line links to the work. **Send it by**: email, your chat hook, or both.
Nothing happened, nothing is sent. **Send me one now** sends the last 24
hours at once, even when empty.

It goes out from its hour until four hours after (so an API restart at the
wrong moment doesn't skip the day), once per day, from one API instance
(the five-minute housekeeping tick, `OPTIO_NOTIFY_TICK_MS`). After days
without one (the API was down), the next one covers up to a week.

## When the relay is down: retries and Undelivered

Every email and chat post goes into a queue (the table `notify_outbox` and
the BullMQ queue `notify-outbox`) before it is sent. When the relay or the
chat can't be reached, answers 4xx (SMTP) or 5xx (HTTP), or times out,
Optio tries again after 30 seconds, then twice as long each time: ten tries
over about four hours by default. Nothing is lost while it waits: a job
Redis lost is queued again from its row within minutes.

When the tries run out, or the far end refused it for good (the relay
answered 5xx to every recipient or to the message, the chat answered 4xx —
a deleted hook — or the outbound policy blocks the host), the email or post
is kept as **undelivered**. **Settings → Notifications → Undelivered**,
for deployment admins: what still waits (and since when), and each
undelivered one with its recipient, its subject, its tries and the last
error, to **Retry** (a fresh set of tries) or **Discard**, one by one or
all. They are kept for 30 days. A chat post names whose hook it was for,
never the URL. Retries and discards are in the audit trail
(`notify.outbox.retry` / `.discard`, deployment-wide).

| Environment                       | Helm value                              | Meaning                                                     |
| --------------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| `OPTIO_NOTIFY_RETRY_ATTEMPTS`     | `notifications.delivery.attempts`       | Tries per email or chat post, the first included (10)       |
| `OPTIO_NOTIFY_RETRY_BASE_SECONDS` | `notifications.delivery.baseSeconds`    | The first wait; each next one doubles (30)                  |
| `OPTIO_NOTIFY_DEAD_LETTER_DAYS`   | `notifications.delivery.deadLetterDays` | How long undelivered ones are kept (30)                     |
| `OPTIO_NOTIFY_TICK_MS`            | —                                       | The housekeeping tick: lost jobs, old ones, digests (5 min) |

Over the API (deployment admins): `GET /api/notifications/outbox`,
`POST /api/notifications/outbox/retry` and `…/discard` with
`{ "ids": [...] }` (or nothing, for all).

## Setting up email (deployment admins)

Email goes out through an SMTP relay (Exchange, Postfix, a mail gateway, a
mail provider's submission service…). There are two places to set it; the app's setting wins.

**In the app:** Settings → Notifications → **Email**, visible to deployment
admins only (it is the whole deployment's, like sign-in):

| Field          | What to put                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Host, Port     | The relay's name and port (587 for submission, 25 for a relay that takes mail from the cluster, 465 for TLS from the start) |
| Encryption     | **STARTTLS when the relay offers it** (default), **STARTTLS, required**, **TLS from the start (smtps)**, or **None**        |
| User name      | Empty for a relay that takes mail without signing in; otherwise its account. Optio signs in with AUTH PLAIN or LOGIN        |
| Password       | Sealed on save (AES-256-GCM), never shown again; empty keeps it for the same host and user                                  |
| From           | The sender people see: `Optio <optio@example.com>`. The relay must accept it as a sender                                    |
| CA certificate | Only when the relay's certificate is from a CA the chart's `caBundle` doesn't hold                                          |

**Send test email** sends a message with the form as it stands, saved or
not, to the address in its box (yours when empty), and shows the relay's
answer: `250 … queued as …`, or what went wrong. **Use the deployment's**
(or **Remove**) drops the app's setting.

**In the deployment** (Helm `notifications.smtp.*`, docs/observability.md):

```yaml
notifications:
  smtp:
    url: smtp://relay.example.com:25 # or smtps://user:pass@relay.example.com:465
    from: "Optio <optio@example.com>"
```

| Environment                       | Helm value                              | Meaning                                                                                                                                         |
| --------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPTIO_SMTP_URL`                  | `notifications.smtp.url`                | `smtp://[user:pass@]host[:port][?starttls=required\|never]` (port 587 unless given) or `smtps://[user:pass@]host[:port]` (465). Empty: no email |
| `OPTIO_SMTP_FROM`                 | `notifications.smtp.from`               | The From address; default `optio@` the host of `PUBLIC_URL`                                                                                     |
| `OPTIO_SMTP_CA_PEM`               | `notifications.smtp.caPem`              | A CA for the relay alone                                                                                                                        |
| `OPTIO_SMTP_INSECURE_SKIP_VERIFY` | `notifications.smtp.insecureSkipVerify` | `true` skips checking the relay's certificate (a lab only)                                                                                      |

The URL can carry the relay's password: keep it in a Secret of your own with
`existingSecrets.OPTIO_SMTP_URL` rather than in values. Percent-encode `@`,
`:` and `/` in the user name and password.

### TLS and passwords

- Optio trusts the chart's `caBundle` (mounted as `NODE_EXTRA_CA_CERTS`), or
  the CA given for the relay instead. A certificate it doesn't trust stops
  the email with "uses a certificate this Optio doesn't trust: add its CA…".
- With **STARTTLS when offered**, a relay that doesn't offer STARTTLS gets
  the message in the clear — but never a password: Optio refuses to sign in
  over an unencrypted connection unless Encryption is **None**.
- Anything a relay sends after its STARTTLS reply and before TLS starts is
  ignored (RFC 3207).

### When email doesn't arrive

| What you see                                         | Why, and what to do                                                                                                                                                                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Email isn't set up on this Optio"                   | No relay: set one in Settings or `notifications.smtp.url`                                                                                                                                                         |
| "Could not reach the relay host:port (ECONNREFUSED)" | Wrong host or port, or a network policy between the API pod and the relay                                                                                                                                         |
| "doesn't speak TLS from the start"                   | smtps on a STARTTLS port: choose STARTTLS for 25 / 587                                                                                                                                                            |
| "refused the user name or password (535 …)"          | The account or password is wrong, or the relay wants another account for this sender                                                                                                                              |
| "refused every recipient (550 …)"                    | The relay won't deliver to that domain from this sender; ask its admins to allow Optio's From                                                                                                                     |
| The test arrives, work emails don't                  | The person turned that event off, isn't the work's owner or team admin, or can no longer see the work. The API log says `notify: work event emailed` with counts                                                  |
| Nothing arrives for a while, then all at once        | The relay was down: Optio retried (`notify: delivery to be retried` at debug). Settings → Notifications → Undelivered shows what it gave up on                                                                    |
| A chat hook says "The last post didn't arrive"       | The chat refused or couldn't be reached: a deleted hook answers 404; a host the outbound policy blocks needs `outbound.allowedHosts`. The chat's own words are in the API log (`notify: the chat refused a post`) |

The API logs each failed send (`notify: email not sent`, with the relay's
reason and no message content).

## Outbound webhooks

Besides a person's own hook and a team's channel, an outbound webhook
(**Webhooks** in the sidebar) sends the events it subscribes to, for the
work its creator may see, to any receiver. It has a **body format**, chosen
when it is made or later on its page:

| Format                       | Body                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------ |
| **By the URL** (none chosen) | See below: what webhooks made before formats existed keep                      |
| **Optio JSON** (`generic`)   | `{ "event", "timestamp", "data" }`, for your own receiver                      |
| A chat service               | That service's own message ([Chat services](#chat-services)), whatever the URL |

**By the URL** keeps the original rule — Slack blocks for a `hooks.slack.com`
URL, Optio JSON for anything else — except for a URL only one chat service
uses, which gets that service's message (such a URL refuses Optio JSON):

| URL                                                         | Gets            |
| ----------------------------------------------------------- | --------------- |
| `discord.com/api/webhooks/<id>/<token>` (or discordapp.com) | Discord         |
| `chat.googleapis.com/v1/spaces/<space>/messages`            | Google Chat     |
| `<name>.cloud.mattermost.com/hooks/<id>`                    | Mattermost      |
| `<tenant>.webhook.office.com/webhookb2/…`                   | Microsoft Teams |
| `<name>.rocket.chat/hooks/<id>/<token>`                     | Rocket.Chat     |
| `hooks.slack.com/…`                                         | Slack           |
| `webexapis.com/v1/webhooks/incoming/<id>`                   | Webex           |
| `…/api/v1/external/slack_incoming` (any host)               | Zulip           |

A self-hosted server's address (`https://chat.example.com/hooks/…`), a
Workflows URL (it runs whatever flow it was built for), Discord's `/slack`
and `/github` routes and Zulip's other integrations could be anything, so
they keep the rule; pick their format. A chosen format always wins over
the URL: a webhook set to Optio JSON or Slack sends what it always did.

Anyone's text — a Task's title (often a Jira or GitLab issue's), its branch,
the error — is shown as written in every format: no formatting, no links of
its own and no pings (each service's section says how). Only Optio's own
link and the merge request are links.

A secret signs whichever body is sent (`X-Optio-Signature`, HMAC-SHA256).
The webhook's host must be allowed by the outbound policy
(`outbound.allowedHosts`, e.g. `chat.example.com`). Over the API, `POST`
and `PATCH /api/webhooks` take `"format"`: `"generic"`, one of the chat
formats, or `null` (by the URL).

## Chat services

What Optio posts to each chat service's incoming webhook, for a person's
hook, a team's channel and an outbound webhook alike, listed alphabetically.
On a person's hook or a team's channel, a refusal for good (a 4xx other
than 408, 425 and 429) shows on the hook and anything else is retried
([When the relay is down](#when-the-relay-is-down-retries-and-undelivered));
an outbound webhook keeps its own delivery log and retries.
Each body was written from the service's public documentation, named in its
section, and is tested against an in-process stand-in that checks bodies
the way those documents describe (`apps/api/src/test-utils/fake-chat.ts`);
none was tried against a live service while writing it.

### Discord

- **Make the hook:** **Server Settings** → **Integrations** → **Webhooks**
  → **New Webhook**, choose its channel, then **Copy Webhook URL**
  (`https://discord.com/api/webhooks/<id>/<token>`). It needs the Manage
  Webhooks permission.
- **Optio sends** `{ "embeds": [one embed], "allowed_mentions": { "parse": [] } }`:
  the headline as the embed's title, linked to the work; the work's name;
  its facts as inline fields; the merge request; the error in a code block;
  a digest's sections as fields. Discord's Markdown in anyone's text is
  escaped, and the empty `parse` list means nothing in the message pings
  anyone.
- **Limits:** kept within Discord's embed limits (title 256 characters,
  description 4,096, 25 fields of 1,024, 6,000 in all); a long digest ends
  its lists with "and N more". Discord answers `204 No Content` (`200` and
  the message with `?wait=true`).
- **By the URL:** `discord.com` or `discordapp.com` `/api/webhooks/<id>/<token>`;
  not its `/slack` and `/github` routes, which take those services' bodies.
- **Checked against:** Discord's Execute Webhook, Embed Limits and Allowed
  Mentions documentation; the stand-in only.

### Email (SMTP relay)

Not a chat, but the same events, choices and retries: see
[Setting up email](#setting-up-email-deployment-admins).

### Google Chat

- **Make the hook:** in Chat in a browser, the arrow next to the space's
  name → **Apps & integrations** → **Add webhooks**; name it and save, then
  its **⋮** menu → **Copy link**
  (`https://chat.googleapis.com/v1/spaces/<space>/messages?key=…&token=…`;
  the token is the secret part). An organization can turn webhooks off.
- **Optio sends** `{ "cardsV2": [one card] }`: the headline and the work's
  name in the card's header (plain text there), the facts as decorated
  text, the merge request as a link, the error, **Open in Optio** and **Open
  the merge request** buttons, and a digest's sections with linked items.
  Card text takes a few HTML tags, so anyone's text is HTML-escaped (a
  `<users/all>` in it is text).
- **Limits:** 32,000 bytes a message (a long digest lists fewer lines to
  stay within it); one request a second per space, shared by its webhooks
  (a `429` is retried).
- **By the URL:** `chat.googleapis.com/v1/spaces/<space>/messages`.
- **Checked against:** Google's incoming webhook quickstart (which shows
  `{ "text" }` bodies) and the `spaces.messages` Message resource and Cards
  v2 reference for `cardsV2`; whether a space's webhook takes cards was not
  confirmed on a live space. The stand-in only.

### Mattermost

- **Make the hook:** **Integrations** → **Incoming Webhooks** → **Add
  Incoming Webhook**; pick the channel (or for your own hook, a direct
  message). The URL ends in `/hooks/<id>`.
- **Optio sends** `{ "text": … }` in Markdown: the event, the work linked to
  Optio, repository, branch, merge request, and the error in a code block.
  Markdown in anyone's text is escaped and `@channel`, `@all` or `@someone`
  in it pings nobody.
- **By the URL:** only Mattermost Cloud (`*.cloud.mattermost.com`); for a
  self-hosted server, pick Mattermost.

### Microsoft Teams

- **Make the hook:** a channel's **Workflows** → "Post to a channel when a
  webhook request is received", and copy the URL it gives; or an Office 365
  connector's incoming webhook (`*.webhook.office.com`).
- **Optio sends** a message with one Adaptive Card (1.4): the headline, the
  name, the facts, the error, and **Open in Optio** and **Open the merge
  request** buttons. A `[text](link)` in anyone's text stays text.
- **By the URL:** only `*.webhook.office.com`; a Workflows URL runs whatever
  flow it was built for, so pick Microsoft Teams for it.

### Rocket.Chat

- **Make the hook:** **Manage** → **Workspace** → **Integrations**, the
  **Incoming** tab → **New**; turn it on, fill in the channel to post to
  and the user to post as, save, and copy the URL
  (`https://<server>/hooks/<id>/<token>`).
- **Optio sends** `{ "text", "attachments" }`: the headline as the message;
  an attachment with the work's name as its title linked to Optio, the
  facts and the merge request as fields, the error in a code block, in the
  event's colour; a digest's sections as one attachment each. In anyone's
  text a mention (`@all`) and a link (`[text](url)`, `<url|text>`) are broken
  with a zero-width space.
- **By the URL:** only Rocket.Chat Cloud (`*.rocket.chat`); for a
  self-hosted server, pick Rocket.Chat.
- **Checked against:** Rocket.Chat's Integrations documentation (incoming
  webhooks) and its Post Message payload (`attachments` with `title`,
  `title_link`, `text`, `color`, `fields`); the stand-in only.

### Slack

- **Make the hook:** a Slack app's **Incoming Webhooks** → **Add New Webhook
  to Workspace**, and pick the channel (`https://hooks.slack.com/services/…`).
- **An outbound webhook** sends the Slack blocks it always has, unchanged.
- **A person's hook or a team's channel** gets `{ "text", "blocks" }`: a
  header, the work's name linked to Optio, the facts and the merge request
  as fields, the error, a digest's sections, links. In anyone's text `&`,
  `<` and `>` are escaped as Slack asks, so it never links or mentions.
- **Limits:** a header's 150 characters, a section's 3,000, ten fields of
  2,000 each.
- **By the URL:** `hooks.slack.com`, as before.
- **Checked against:** Slack's Block Kit reference (header and section
  blocks); the stand-in only.

### Webex

- **Make the hook:** the **Incoming Webhooks** app on Webex App Hub →
  **Connect**; at the bottom of its page give the webhook a name, choose
  the space, **Add**, and copy the webhook URL
  (`https://webexapis.com/v1/webhooks/incoming/<id>`).
- **Optio sends** `{ "markdown": … }`: Markdown, with anyone's text
  escaped (chat-text.ts `mdText`; a `<@all>` in it is text).
- **Limits:** cut to 5,400 characters, the Webex app's limit per post, and
  7,439 bytes, the Messages API's limit for `markdown` (not re-read here:
  that reference page didn't load).
- **By the URL:** `webexapis.com/v1/webhooks/incoming/<id>`.
- **Checked against:** the Incoming Webhooks app's page on Webex App Hub
  (`text` or `markdown` bodies) and Webex's help on message limits; the
  stand-in only.

### Zulip

- **Make the hook:** **Personal settings** → **Bots** → add a bot of type
  **Incoming webhook**; then its link icon (Actions) → Integration
  **Slack-compatible webhook**, the channel and, if you like, one topic for
  everything → **Copy URL**
  (`https://<org>.zulipchat.com/api/v1/external/slack_incoming?api_key=…&stream=…`).
  Without a channel, Zulip sends the messages to the bot's owner.
- **Optio sends** `{ "text": … }` in Zulip's Markdown. Zulip turns Slack's
  `*bold*`, `_italic_`, `~strike~` and `<url|text>` in a Slack-compatible
  message into its own; Optio's own markup and escaped characters (`\*`) pass
  unchanged, so anyone's text stays as written. The error is one escaped
  line, not a code block, which that conversion would reach into.
- **Limits:** cut to 10,000 characters (a Zulip server's message limit is
  its own setting).
- **By the URL:** any URL whose path is `/api/v1/external/slack_incoming`,
  Zulip's own route; its other integrations take other bodies.
- **Checked against:** Zulip's documentation of the Slack-compatible
  incoming webhook and of incoming webhook URLs; its conversion of Slack
  formatting is mirrored in the stand-in from Zulip's source
  (`zerver/data_import/slack_message_conversion.py`), so the tests read the
  text Zulip would show. The stand-in only.

## Sending a notification from code

Other parts of Optio tell people things through one call,
`notify()` in `apps/api/src/services/notify.ts`, by email and on each
person's own chat hook:

```ts
import { notify } from "./notify.js";

const result = await notify({
  kind: "budget.warning", // list it in services/notify/kinds.ts
  toTeamAdminsOf: team.id, // and/or toUserIds: [userId]
  workspaceId: team.workspaceId, // only that workspace's members get it
  subject: "Platform used 80% of this month's budget",
  body: "The team has used 80 of its 100 USD for October.",
  link: "/usage", // a path under PUBLIC_URL, or a full URL
});
// result: { sent: [userId…], skipped: [{ userId, why }], chat?: [userId…], teamChannels?: [teamId…], error? }
```

- **Recipients**: `toUserIds`, plus the active admins of each team in
  `toTeamAdminsOf`, once each. `workspaceId` (or the team's workspace) keeps
  it to that workspace's members. Pass `work` (the owner columns of a piece
  of work: `workspaceId`, `ownerUserId`, `ownerTeamId`, `createdBy`) when the
  message is about work: then only people who may see that work get it.
- **Choices**: the person's email and chat switches for `kind` apply. Add
  the kind to `NOTIFY_KINDS` in `services/notify/kinds.ts` (label,
  description, whether it is emailed by default — chat starts the same) so
  it shows in Settings and people can turn it off; a kind not listed is
  sent and can't be turned off. `force: true` ignores the choice, for what
  someone must be told (an offboarding notice).
- **A team's channel**: each team in `toTeamAdminsOf` whose channel lists
  `kind` gets it there too (`TEAM_CHANNEL_KINDS` in
  `services/notify/chat-hooks.ts` says which kinds a channel can take);
  with `work`, only when it is that team's work.
- `sent` means queued for delivery: the outbox retries it. It never throws.
  With neither a relay nor any chat hook it sends nothing and says so in
  `error`; a person with no way to be reached is in `skipped`, with `why`
  `NO_ADDRESS` (no usable address and no hook: nothing reaches them until
  they add one) or `NO_RELAY` (an address, but email isn't set up yet), both
  exported from `services/notify.ts`. Code that keeps a notice due until it
  is delivered (credential-health/alerts.ts `delivered`) counts a team
  channel's post as delivered, counts `NO_ADDRESS` people as no one, and
  keeps it due for `NO_RELAY`.
- `canNotify()` says whether anything can go out at all (a relay, or a hook).
- Tests swap the transports:
  `setEmailTransportForTests(createMemoryEmailTransport())` from
  `services/notify/email.ts` and
  `setChatTransportForTests(createMemoryChatTransport())` from
  `services/notify/chat-hooks.ts`, then read `transport.sent` / `.posts`.
  Without the worker in the process, deliveries are sent at once; a test of
  the queue starts it (`startNotifyWorker()` in `workers/notify-worker.ts`)
  with `OPTIO_NOTIFY_RETRY_BASE_SECONDS=0.05`.

## Where it lives

| Part                            | Code                                                                                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SMTP client, message format     | `apps/api/src/services/notify/smtp.ts`, `mime.ts`                                                                                                                                                                                                   |
| The relay's settings (env, app) | `services/notify/smtp-config.ts`; table `notify_smtp_settings`                                                                                                                                                                                      |
| Sending, the test transport     | `services/notify/email.ts`                                                                                                                                                                                                                          |
| Work events → email and chat    | `services/notify/dispatch.ts`; hooks in `notification-service.ts` and `workflow-service.ts`                                                                                                                                                         |
| One message to each channel     | `services/notify/fanout.ts`                                                                                                                                                                                                                         |
| The queue, retries, Undelivered | `services/notify/outbox.ts`, `workers/notify-worker.ts`; table `notify_outbox`                                                                                                                                                                      |
| Own chat hooks, team channels   | `services/notify/chat-hooks.ts`, `chat-messages.ts`; table `notify_chat_hooks`                                                                                                                                                                      |
| The daily digest                | `services/notify/digest.ts`; columns `notification_preferences.digest_sent_on`, `digest_sent_at`                                                                                                                                                    |
| Who receives                    | `services/notify/recipients.ts`                                                                                                                                                                                                                     |
| Choices                         | `services/notify/preferences.ts`, `kinds.ts`; column `notification_preferences.channels`                                                                                                                                                            |
| Email words                     | `services/notify/templates.ts`                                                                                                                                                                                                                      |
| Chat formats                    | `packages/shared/src/chat-formats.ts` (the list, recognising a URL); `services/notify/chat-formats.ts`, `chat-posts.ts`, `chat-text.ts`; hook in `webhook-service.ts`; columns `webhooks.format`, `notify_chat_hooks.format`                        |
| The chat services' stand-in     | `apps/api/src/test-utils/fake-chat.ts`                                                                                                                                                                                                              |
| `notify()`                      | `services/notify.ts`                                                                                                                                                                                                                                |
| Routes                          | `routes/notify.ts`, `routes/notify-delivery.ts`                                                                                                                                                                                                     |
| Web                             | `components/notifications/my-notifications.tsx`, `my-chat-hook.tsx`, `my-digest.tsx`, `components/settings/email-settings.tsx`, `undelivered-notifications.tsx`, `components/teams/team-chat-channel.tsx`, `components/webhooks/webhook-format.tsx` |
| Migrations                      | `apps/api/src/db/migrations/1792720000_notifications.sql`, `1792820000_notify_delivery.sql`                                                                                                                                                         |
