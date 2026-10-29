# The Forge — multi-agent demo

A four-agent engineering team that lives inside Optio as Persistent Agents and
coordinates by passing messages.

| Slug         | Name       | Role                                                                      |
| ------------ | ---------- | ------------------------------------------------------------------------- |
| `vesper`     | Vesper     | Architect — receives feature requests, breaks them into specs, dispatches |
| `forge`      | Forge      | Implementer — receives specs, drafts code, reports back to Vesper         |
| `sentinel`   | Sentinel   | Reviewer — receives PR-opened messages, runs review, posts findings       |
| `chronicler` | Chronicler | Scribe — listens to broadcasts, maintains a running team journal          |

## How it works

1. You message **Vesper** with a feature request via the chat in `/agents/vesper`.
2. Vesper decomposes it into one or more spec messages and `send`s them to **Forge**.
3. Forge drafts the implementation (just code in this demo — no real PR yet) and
   `send`s a "PR opened" message back to Vesper and a `broadcast` to the team.
4. Sentinel hears the broadcast, reviews the proposal, and `send`s comments back
   to Forge.
5. Chronicler hears every broadcast and appends an entry to the team journal,
   which it returns when anyone messages it `journal`.

This shows off three messaging patterns from the Scion / Athenaeum playbook:
**direct messages** (Vesper → Forge), **broadcasts** (Forge → all), and
**file-based handoff** (Chronicler → `journal`).

## Setup

Requires a running Optio API (default `http://localhost:30400`). See
[../../README.md](../../README.md) for `setup-local.sh`.

```bash
# Default API base — override with $OPTIO_API_URL
./demos/the-forge/setup.sh
```

The script creates all four agents in your current workspace, idempotent
(re-runs are safe — slug uniqueness is enforced server-side).

## Try it

1. Open `/work?view=agents` — you should see all four.
2. Open `/agents/vesper`, send a message:
   `Add a /healthz endpoint to the api server that returns OK`.
3. Watch the activity feed — Vesper drafts a spec and sends it to Forge.
4. Open `/agents/forge` to see the spec arrive in its inbox and the work it does.
5. Open `/agents/chronicler` to see the journal grow.

## Cleanup

```bash
for slug in vesper forge sentinel chronicler; do
  id=$(curl -s "$OPTIO_API_URL/api/persistent-agents" \
        | jq -r ".agents[] | select(.slug==\"$slug\") | .id")
  [ -n "$id" ] && curl -s -X DELETE "$OPTIO_API_URL/api/persistent-agents/$id"
done
```
