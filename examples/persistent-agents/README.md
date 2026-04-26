# Persistent Agents — examples

Communities of long-lived, named, message-driven agents that wake on user
messages, agent messages, webhooks, cron ticks, or ticket events. See
[../../docs/persistent-agents.md](../../docs/persistent-agents.md) for the
underlying design.

| Example                                         | Pattern                                                                                                                                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`forge`](forge/)                               | Editorial pipeline — Architect → Implementer → Reviewer, with a Scribe maintaining a journal. Best illustrates dispatch, broadcast, and `/workspace/` file-based memory.                              |
| [`mars-mission-control`](mars-mission-control/) | Scheduled forcing function — a Clock agent broadcasts a new "incident" every sol, specialists swarm a coordinated response. Best illustrates cron-triggered communities and parallel expert handoffs. |

## Authoring your own

A persistent-agent example folder has this shape:

```
my-example/
├── README.md
├── agents/
│   ├── orchestrator.json
│   └── specialist-N.json
└── setup.sh
```

Each `*.json` is the **body** of `POST /api/persistent-agents` — full schema in
[`apps/api/src/routes/persistent-agents.ts`](../../apps/api/src/routes/persistent-agents.ts),
but the load-bearing fields are:

- **`slug`** — addressable name within the workspace (lowercase, hyphens, must be unique)
- **`name`**, **`description`** — UI labels
- **`agentRuntime`** — `claude-code` | `codex` | `copilot` | `gemini` | `opencode`
- **`podLifecycle`** — `always-on` | `sticky` | `on-demand` (see docs)
- **`systemPrompt`** — the persona; constant across all turns
- **`agentsMd`** — operator manual; teaches the agent how to use the inter-agent
  HTTP API. Reuse one of the existing examples' `agentsMd` as a starting point.
- **`initialPrompt`** — what the agent does on its very first turn

The `setup.sh` script is straightforward — `curl -X POST` each agent JSON, treat
HTTP 409 as "already exists." See [`forge/setup.sh`](forge/setup.sh) as a template.

If your example needs a **scheduled trigger** (like Mars's Clock), provision it
in `setup.sh` after the agent exists by `POST /api/tasks/:id/triggers` with
`{ type: "schedule", config: { cronExpression: "..." } }` against the
agent's id. The polymorphic trigger dispatch handles `target_type='persistent_agent'`
automatically — see [`mars-mission-control/setup.sh`](mars-mission-control/setup.sh).
