# Log redaction

An agent can print a credential: `env`, `git remote -v` with a token in the
URL, a verbose `curl`, a stack trace with a connection string. Without
redaction that line is stored in the run's log (`task_logs`) and streamed to
everyone who can see the run. With redaction on, Optio masks secrets in every
run's output before the line is stored, so what is stored, what the live stream sends, and
what the log page shows later are the same masked text.

Every writer of `task_logs` goes through one place (`run-log-service.ts`), and
every live frame carries the stored row, so this covers Repo Tasks, Job runs,
PR-review runs and persistent-agent turns, and the system lines Optio writes
about them (a failed push, say).

## The run's own secrets (`OPTIO_LOG_REDACT_SECRETS=true`)

When a run starts, Optio remembers the exact values it put in the run's
environment as credentials:

- the secrets it resolved for the run (the agent's sign-in, the git token,
  the work's pod secrets, a connection's shell env);
- any other variable whose name says it is a credential (`*_TOKEN`,
  `*_SECRET`, `*_PASSWORD`, `*_API_KEY`, `*_ACCESS_KEY`, …), which covers
  minted git tokens and OAuth tokens.

Any of those values that appears in the output, as is, URL-encoded, or
escaped inside a JSON string, is replaced by `[redacted:NAME]`, where NAME is
the variable it came from. Values shorter than 8 characters are left alone,
and so are Optio's own settings kept as secrets (auth modes, hosts, regions,
cloud project ids), so the mask can't hit ordinary output: a string that
equals one of these values is that credential.

Turn it on with `OPTIO_LOG_REDACT_SECRETS=true` (Helm
`logRedaction.runSecrets: true`). It is off by default, so output is stored
exactly as printed unless a deployment turns it on.

Any API instance may stream a run (the one that started it, or one that
attaches after a restart or a rollout), so the values are also kept in Redis,
encrypted with the deployment's `OPTIO_ENCRYPTION_KEY` (AES-256-GCM, bound to
the run's id), for 7 days after the run last read them.

## Token shapes (opt-in)

With `OPTIO_LOG_REDACT_PATTERNS=true` (Helm `logRedaction.tokenPatterns:
true`), well-known token formats are masked too, wherever they came from:

| Shape                                                                 | Shown as                    |
| --------------------------------------------------------------------- | --------------------------- |
| GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`) | `[redacted:github-token]`   |
| GitLab tokens (`glpat-`, `gldt-`, `glrt-`, …)                         | `[redacted:gitlab-token]`   |
| AWS access key ids (`AKIA…`, `ASIA…`)                                 | `[redacted:aws-access-key]` |
| JWTs                                                                  | `[redacted:jwt]`            |
| PEM private key blocks                                                | `[redacted:private-key]`    |
| `Bearer` credentials                                                  | `Bearer [redacted:bearer]`  |

This is off by default because a pattern can match text that only looks like
a token (a test fixture, an example in documentation).

## What it does not cover

- Secrets Optio never saw: a credential the agent reads from a file in the
  repository, or one a tool fetches at run time. The token shapes catch the
  common formats of those.
- Credentials Optio writes only into the run's setup files (an MCP server's
  config), not its environment.
- With token shapes on, a private key the agent prints line by line: each
  line of the block is a log line of its own, so the `BEGIN` line is masked
  and the key's body lines are not. A block inside one line (a tool's output) is masked whole.
- Output already stored before an upgrade.
- The run's result summary and error message on the run itself, and session
  chat transcripts, which are stored outside `task_logs`.
