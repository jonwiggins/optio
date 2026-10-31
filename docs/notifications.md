# Email notifications

Email is disabled until a deployment admin configures an SMTP relay under
Settings → Notifications or through `OPTIO_SMTP_URL`. Browser and phone push
keep their existing configuration and preferences.

## Messages and recipients

Email covers work opening a merge request, needing attention, or failing.
Completion messages are off by default. Held or failed directory-sync runs notify
deployment administrators when the state changes, excluding the operator who
started the run. Offboarding notices go to the other
enabled administrators of the affected workspace, excluding the administrator
who disabled the account.

A work message goes to its owner, or its creator for organization work, only
while that person remains enabled, a workspace member, and allowed to see the
work. The recipient's address must be verified by their sign-in provider.
Queued deliveries check that the account is still enabled and that the stored
address (compared without regard to case) remains its verified address; mail
that fails this check is dropped and logged as dropped, not counted as sent. People choose their own email events
under Settings → Notifications (`GET/PUT /api/notifications/channels`).

Messages contain the work title, repository, merge request and a link under
`PUBLIC_URL`. Failure messages include only the first summary line; agent
stderr and subsequent tool output are never copied into the email body or
outbox payload.

## SMTP configuration

`smtp://[user:password@]relay[:port]` defaults to port 587 and **required
STARTTLS**. `smtps://` uses implicit TLS on port 465. Opportunistic STARTTLS is
an explicit `?starttls=optional` choice and can send a body in plaintext;
`?starttls=never` explicitly disables encryption. A password is sent over a
plaintext connection only when None is explicitly selected.

Set `OPTIO_SMTP_FROM` (or Helm `notifications.smtp.from`) to the sender address;
the default is `optio@` the host of `PUBLIC_URL`. `OPTIO_SMTP_CA_PEM` supplies a
private relay CA. Node's extra CA bundle is also supported. The optional lab
certificate-verification bypass is recorded on the SMTP settings audit entry.
The SMTP password is encrypted at rest, never returned, and reused only when
host, port, username, encryption mode, CA and certificate-verification setting
all match. Changing any of those requires entering the password again.

Relay DNS answers pass through the deployment's outbound policy before a socket
opens, and the socket connects to a vetted address, trying the next vetted
address when one can't be reached. Private relays require an
administrator-controlled `outbound.allowedHosts` entry (or the deployment's
broader private-network policy). Loopback and metadata endpoints stay blocked
unless explicitly permitted. SMTP tests follow the same rules.

## Delivery retries

When the worker runs, emails are stored in `notify_outbox` and sent through
BullMQ with exponential backoff. Defaults are ten attempts, starting at 30
seconds. `OPTIO_NOTIFY_RETRY_ATTEMPTS` and `OPTIO_NOTIFY_RETRY_BASE_SECONDS`
configure the bounds. Successful rows are deleted; permanent or exhausted
failures become dead letters. Failed queue jobs are retained until their
durable dead-letter update succeeds, so housekeeping cannot restart an
exhausted retry budget after worker exceptions.

Deployment admins can inspect, retry or discard dead letters under Settings →
Notifications. Retry and discard write `notify.outbox.retry` and
`notify.outbox.discard` action-log entries. Dead letters are removed after
`OPTIO_NOTIFY_DEAD_LETTER_DAYS` (30 by default). Their bodies remain in the
database until deletion. Manual retry retains the original recipient address
and still checks its current verified owner.

## Chat services

Optio can post to the incoming webhooks of Discord, Google Chat, Mattermost,
Microsoft Teams, Rocket.Chat, Slack, Webex and Zulip. Both uses below are off
until someone sets them up.

### Outbound webhooks

An outbound webhook (Webhooks page, `POST/PATCH /api/webhooks`) takes an
optional `format`: `generic` (Optio's `{ event, timestamp, data }` JSON) or one
of `discord`, `googlechat`, `mattermost`, `msteams`, `rocketchat`, `slack`,
`webex`, `zulip`. Without a format nothing changes from before: a
`hooks.slack.com` URL gets Slack blocks, a URL only one chat service uses (for
example `https://discord.com/api/webhooks/<id>/<token>`) gets that service's
message, and anything else gets the generic JSON. Signatures, retries and the
outbound guard are the same for every format. A chat message carries only the
first line of a failure.

### Your own chat hook

Under Settings → Notifications → Your chat hook, anyone signed in (viewers
too) can paste an incoming webhook into their own channel or a direct message,
for example `https://chat.example.com/hooks/abc123`, and pick the chat when the
URL doesn't say. A Chat column then appears next to Email in "What reaches
you"; it starts with the same events as email and each switch is separate
(`PUT /api/notifications/channels` with `chat`). Send test posts a test message
now (at most ten a minute).

- The URL is a credential: it is encrypted at rest (AES-256-GCM, bound to the
  hook's row) and never returned; Settings and the API show only a hint such
  as `https://chat.example.com/hooks/…c123`.
- Posts go through the deployment's outbound guard: DNS answers are checked
  against the outbound policy and `outbound.allowedHosts`, the connection is
  pinned to a checked address, and redirects are refused. A chat server on a
  private network needs an `outbound.allowedHosts` entry.
- A failed post reports only the HTTP status and what it means, or a fixed
  "could not reach" / "not allowed by the outbound policy" line. The chat's
  answer and connection details go to the API log only.
- Saving and removing a hook are recorded in the action log
  (`notify.chat_hook.set`, `notify.chat_hook.delete`), with
  `plaintextHttp: true` when the URL is `http://`, which sends the URL and
  every message unencrypted.
- A post follows the same rules as email: it goes only to the work's owner
  (or starter) while they are an enabled workspace member who may see the
  work. Queued posts go through the same outbox and retry limits; a 4xx
  answer other than 408, 425 and 429, or a host the outbound policy refuses,
  is a dead letter at once. At delivery the hook is looked up again: if it was
  removed or turned off, or its owner was disabled, the post is dropped.

Team channels follow with teams.

## The daily digest

Off by default. Under Settings → Notifications → Daily digest, each person can
turn on one message a day at an hour they pick in their own time zone (the
browser's when they turn it on; any IANA zone such as `Europe/Berlin` through
`PUT /api/notifications/channels` with `digest: { enabled, hour, timeZone, via }`),
by email, on their own chat hook, or both.

It lists, per workspace the person is still a member of:

- Waiting for you: their merge requests that are open and work that needs
  them.
- Failed: their work that failed since the last digest, with only the first
  line of the failure. A Job run counts once, at its last try; a cancel
  doesn't count.
- Merged: their work whose merge request merged since the last digest.

"Their work" is the same as for single events: work they own, and the
organization's work they started, that they may still see. Up to 15 lines a
section, then "and N more". With nothing to report, nothing is sent.

The worker's housekeeping tick (every five minutes, `OPTIO_NOTIFY_TICK_MS`)
sends a digest from its hour until four hours after, once per local day; the
day is claimed in the database first, so several API instances never send it
twice. A digest covers at most the last seven days. A disabled account gets
none, email goes only to a verified address, and both channels go through the
outbox with the usual retries. "Send me one now" (`POST
/api/notifications/digest/test`, at most five a minute) sends the last 24 hours
right away, even when empty.
