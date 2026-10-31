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
