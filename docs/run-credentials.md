# Which credentials a run used

When a token or key leaks, the first question is which work used it. Optio
records, for every run, which credentials it was given, and a deployment
admin can search that record.

## What is recorded

A row in `run_credentials` for each credential a run is given. Runs are Repo
Tasks, Job runs, PR reviews, persistent agent turns and sessions. Each row
holds:

- the run (kind and id), its workspace, whose work it was (null for the
  organization's), and its repository
- the credential's kind (`git-token`, `model-key`, `secret`, `github-app`,
  `model-provider`), scope (`personal`, `workspace`, `deployment`, `repo`,
  `environment`) and name
- the stored row's id (a secret, agent credential or model provider), and the
  git host for a git credential
- a fingerprint: the first 16 hex digits of HMAC-SHA-256 of the value, keyed
  from `OPTIO_ENCRYPTION_KEY`
- when it was used

The value itself is never stored. The fingerprint is keyed, so a copy of the
database alone can't be used to test guesses at a weak secret. Changing
`OPTIO_ENCRYPTION_KEY` changes every fingerprint, so older rows are found by
name or id instead.

Only lookups that found something are recorded, once per run attempt. A git token
handed over later by the in-pod credential helper is recorded when the run
starts, the way the helper will resolve it. Optio's own settings stored as
secrets (`*_AUTH_MODE`, hosts, regions) are not credentials and are skipped.

Rows have no foreign keys: they outlive the run, the secret and the person
they name.

## Searching

Settings → Access → Credential use, shown to deployment admins. Paste a
leaked value (it is sent once in the request body, hashed, and dropped), or
enter a credential's name, and narrow by time. The result lists each run with
its workspace, person, repository and time, and exports as CSV.

The API is `POST /api/credential-use/search` and
`POST /api/credential-use/export` (CSV), both for deployment admins only.
Each search and export is in the action log (`credential_use.search`,
`credential_use.export`) with the fingerprint searched for, never the value.

## Turning it on

Recording is off by default. To turn it on, set
`OPTIO_RECORD_RUN_CREDENTIALS=true` on the API (Helm: `api.env`). It stores
identities only and costs one small insert per credential per run.
