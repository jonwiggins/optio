# Optio examples

Working configurations and setup scripts for the kinds of [session](../docs/tasks.md)
Optio runs — one-shot PR sessions, no-repo jobs, and persistent multi-agent swarms.
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
├── repo-tasks/         # Where = pod + repo, Then = exits — agents that open a PR
├── standalone-tasks/   # Where = pod, no repo, Then = exits — single-shot jobs
└── persistent-agents/  # Then = persistent agent — long-lived, message-driven swarms
```

Pick by what shape of work you have (the folder names are the pre-v0.5 kind names; in
the UI all of these are sessions):

| You want…                                             | Session shape                                  | Folder               |
| ----------------------------------------------------- | ---------------------------------------------- | -------------------- |
| An agent that opens a PR and is done                  | pod + repo, exits when done                    | `repo-tasks/`        |
| A scheduled or webhook-triggered single-shot job      | pod, no repo, exits when done, cron / webhook  | `standalone-tasks/`  |
| A long-lived service that wakes on messages or events | persistent agent                               | `persistent-agents/` |
| Multiple coordinating agents with dispatch + handoff  | several persistent agents messaging each other | `persistent-agents/` |

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

After provisioning, everything shows up in the unified **Sessions** feed at `/sessions`
(persistent agents under the **Agents** view, triggered definitions under **Recurring**,
runs under **Active** / **History**). The per-kind detail pages still exist:

| Example folder       | Sessions view | Detail page                           |
| -------------------- | ------------- | ------------------------------------- |
| `persistent-agents/` | Agents        | `/agents/:id`                         |
| `repo-tasks/`        | Active        | `/tasks/:id`                          |
| `standalone-tasks/`  | Recurring     | `/jobs/:id` → `/jobs/:id/runs/:runId` |

> As of v0.5 the sidebar is **Work** (Sessions · Reviews · Inbox) and **Library** (Prompts · Repos · Machines · Connections). `/tasks/new`, `/jobs/new`, `/agents/new`, and the legacy `/tasks?tab=…` URLs all redirect.

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
