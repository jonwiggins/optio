# Optio examples

Working configurations and setup scripts for the three Task tiers in Optio.
Each example is **self-contained**, **runnable** against a local Optio cluster,
and **idempotent** (re-running setup scripts is safe).

Use these as documentation-by-example: copy a folder, modify the agents to suit
your use case, re-run `setup.sh`. Every example follows the same shape:

```
<example-name>/
  README.md     # what it does, how to run, what to expect
  agents/       # one JSON per agent (or task/workflow definition)
  setup.sh      # idempotent provisioning script
```

## Layout

```
examples/
├── repo-tasks/         # Repo Tasks — agents that run in a worktree, open a PR
├── standalone-tasks/   # Standalone Tasks — single-shot agents, no repo
└── persistent-agents/  # Persistent Agents — long-lived, message-driven
```

Pick by what shape of work you have:

| You want…                                             | Tier             |
| ----------------------------------------------------- | ---------------- |
| An agent that opens a PR and is done                  | Repo Task        |
| A scheduled or webhook-triggered single-shot job      | Standalone Task  |
| A long-lived service that wakes on messages or events | Persistent Agent |
| Multiple coordinating agents with dispatch + handoff  | Persistent Agent |

## Available examples

### Persistent Agents

| Example                                                           | Agents | Showcases                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`forge`](persistent-agents/forge/)                               |      4 | A four-agent engineering team — architect dispatches specs to an implementer, reviewer reviews PRs, scribe maintains a team journal. Direct messages + broadcasts + always-on (Chronicler) vs sticky (the rest) pod lifecycle.                                                                                                  |
| [`mars-mission-control`](persistent-agents/mars-mission-control/) |      7 | A flight-control team handling five sols of escalating incidents on Mars. A `Clock` agent fires scheduled "events" via a cron trigger; specialists coordinate a response broadcast by broadcast. Showcases scheduled-trigger-as-forcing-function, parallel specialist handoffs, and `/workspace/`-based mission log continuity. |

### Repo Tasks

> _Examples coming. Open a PR to contribute one. The shape is `repo-tasks/<name>/{README.md, task.json, setup.sh}` where `task.json` is the body of `POST /api/tasks` with `type: "repo-blueprint"`._

### Standalone Tasks

> _Examples coming. Open a PR to contribute one. The shape is `standalone-tasks/<name>/{README.md, workflow.json, setup.sh}` where `workflow.json` is the body of `POST /api/jobs`._

## Running an example

All scripts assume an Optio API at `http://localhost:30400` (the
`setup-local.sh` default). Override with `OPTIO_API_URL`, and pass
`OPTIO_API_TOKEN` if your server requires auth (local dev with
`OPTIO_AUTH_DISABLED=true` doesn't).

```bash
# default
./examples/persistent-agents/forge/setup.sh

# remote / authed
OPTIO_API_URL=https://optio.acme.com \
OPTIO_API_TOKEN=$(cat ~/.optio-token) \
  ./examples/persistent-agents/forge/setup.sh
```

After provisioning, open the corresponding UI surface:

| Tier              | UI                               |
| ----------------- | -------------------------------- |
| Persistent Agents | `/agents` (list) → `/agents/:id` |
| Repo Tasks        | `/tasks?tab=repo`                |
| Standalone Tasks  | `/tasks?tab=standalone`          |

## Cleanup

Each example documents its own cleanup snippet in its README, but the universal
form for persistent agents is:

```bash
# Delete every agent provisioned by an example
for slug in $(jq -r '.slug' examples/persistent-agents/<name>/agents/*.json); do
  id=$(curl -s "$OPTIO_API_URL/api/persistent-agents" \
        | jq -r ".agents[] | select(.slug==\"$slug\") | .id")
  [ -n "$id" ] && curl -s -X DELETE "$OPTIO_API_URL/api/persistent-agents/$id"
done
```
