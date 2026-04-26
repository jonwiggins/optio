# Persistent Agents

A third tier of Task in Optio, alongside Repo Tasks and Standalone Tasks.

> **Repo Task** — agent runs in a repo worktree, opens a PR, terminates.
> **Standalone Task** — agent runs once with no repo, produces side effects, terminates.
> **Persistent Agent** — long-lived, named, message-driven. _Doesn't terminate._

A Persistent Agent (PA) executes one **turn** of work, halts, and waits to be
re-woken by a user message, an agent message, a webhook, a cron tick, or a
ticket event. Each PA has a stable `slug` and is addressable by other PAs in
the same workspace via the inter-agent HTTP API.

Inspiration: [Scion](https://github.com/GoogleCloudPlatform/scion) +
[scion-athenaeum](https://github.com/ptone/scion-athenaeum). The "service
model" rather than the "job model" — turns are the inputs, not the unit.

## Mental model

|            | Job model (Repo / Standalone Tasks) | Service model (Persistent Agents)    |
| ---------- | ----------------------------------- | ------------------------------------ |
| Identity   | The run                             | The agent itself                     |
| Lifecycle  | One-shot                            | Cyclic — turns until paused/archived |
| Inputs     | Params                              | Messages                             |
| Outputs    | Logs + PR or side effects           | Messages + side effects              |
| Addressing | Run ID                              | `agent:<workspace>/<slug>`           |

## Lifecycle

```
idle ── pending msg / intent ──▶ queued ──▶ provisioning ──▶ running
  ▲                                                              │
  └────────────────── turn halted (success) ─────────────────────┘
```

Failed turns are retried by re-waking until `consecutive_failure_limit` is
exceeded, at which point the PA transitions to `failed` and requires manual
`resume`. Other terminal-ish states: `paused` (manual pause/resume),
`archived` (terminal, kept for history).

## Pod lifecycle modes

Configurable per agent (default `sticky`):

| Mode        | Behavior                                                                         | Cost    | Latency                        |
| ----------- | -------------------------------------------------------------------------------- | ------- | ------------------------------ |
| `always-on` | Pod stays running until the agent is paused/archived.                            | Highest | Instant                        |
| `sticky`    | Pod kept warm for `idle_pod_timeout_ms` after each turn; cold-restart otherwise. | Medium  | Fast (in window) / Slow (cold) |
| `on-demand` | Cold-start every turn.                                                           | Lowest  | Slow                           |

Pick `always-on` for high-frequency agents (event handlers, monitors),
`sticky` for normal interactive agents, `on-demand` for low-frequency
scheduled agents (e.g. nightly digest).

## Message envelopes

When a turn runs, drained messages are formatted into the prompt as:

```
---BEGIN OPTIO MESSAGE---
{
  "version": 1,
  "timestamp": "2026-04-26T10:00:00Z",
  "sender": "agent:acme/forge",
  "type": "instruction",
  "broadcasted": false,
  "body": "Spec for /healthz endpoint:\n…"
}
---END OPTIO MESSAGE---
```

`sender` follows the format `<type>:<id>`:

- `user:<email|id>`
- `agent:<workspace>/<slug>`
- `system:<label>` (scheduler, init, …)
- `external:<label>` (webhook path, …)

## Inter-agent HTTP API (called from inside agent pods)

Every PA pod gets `OPTIO_API_URL` and `OPTIO_AGENT_TOKEN` env vars. The
agent's `agents.md` operator manual documents the verbs and the agent learns
the API on its own — no special MCP server required (Scion's "agents learn
the CLI" philosophy).

| Verb                                             | Purpose                                |
| ------------------------------------------------ | -------------------------------------- |
| `GET  /api/internal/persistent-agents`           | List addressable agents in workspace   |
| `POST /api/internal/persistent-agents/send`      | Direct message: `{ to: <slug>, body }` |
| `POST /api/internal/persistent-agents/broadcast` | Broadcast to all peers: `{ body }`     |
| `GET  /api/internal/persistent-agents/inbox`     | Read your own recent messages          |

Auth: `X-Optio-Agent-Token: $OPTIO_AGENT_TOKEN` header. v0.4 uses the agent's
own UUID as the token; a follow-up will swap to per-turn signed tokens.

## Wake sources

| Source     | Trigger                                                                |
| ---------- | ---------------------------------------------------------------------- |
| `user`     | UI message from a human via `POST /api/persistent-agents/:id/messages` |
| `agent`    | Another PA used the inter-agent API                                    |
| `webhook`  | `workflow_triggers` webhook with `target_type='persistent_agent'`      |
| `schedule` | Cron trigger fired                                                     |
| `ticket`   | Linear/GitHub issue event (when wired)                                 |
| `system`   | Internal (init, restart, ...)                                          |

## Triggers

PAs reuse the existing `workflow_triggers` polymorphic table. Add a trigger
with `target_type='persistent_agent'`, `target_id=<agent.id>`, and a regular
`type` (`schedule`, `webhook`, `ticket`). The trigger worker dispatches
through `wakeAgent()` instead of `createWorkflowRun()`.

## State persistence across turns

PAs do not (yet) use native CLI session-resume across turns. Each turn is a
fresh agent invocation, with three sources of continuity:

1. **System prompt + agents.md** — constant across all turns.
2. **Drained inbox messages** — assembled into the turn's prompt.
3. **`/workspace/`** — pod-local filesystem. Sticky/always-on lifecycle
   modes preserve files across turns; `on-demand` does not. Pattern:
   agent maintains its own `MEMORY.md`, journals, etc. (see Chronicler in
   the demo).

Native session resume (e.g. `claude --resume`) is a planned upgrade.

## Failure handling

- Turn errors increment `consecutive_failures`.
- After `consecutive_failure_limit` (default 3), the PA transitions to
  `failed` and requires manual `resume` from the UI.
- The `last_failure_reason` and `last_failure_at` are surfaced in the UI.
- Successful turns reset the counter to 0.

## Demo: The Forge

A four-agent engineering team:

- **Vesper** — architect (decomposes feature requests)
- **Forge** — implementer (drafts code)
- **Sentinel** — reviewer
- **Chronicler** — scribe (maintains team journal)

See [`demos/the-forge/README.md`](../demos/the-forge/README.md).

## Reconciliation

PAs are reconciled by the existing K8s-style reconciler. New `RunKind` is
`persistent-agent`. The pure decision function lives in
`packages/shared/src/reconcile/reconcile-persistent-agent.ts`. Producers
that wake the reconciler:

- Message arrives in inbox (`wakeAgent`)
- Trigger fires (worker dispatch)
- Control intent set (UI/API)
- Turn completes (worker `finally`)
- Periodic resync (every 5 min)

## Schema

See migration `1777200001_persistent_agents.sql`. Tables:

- `persistent_agents` — the agent itself
- `persistent_agent_turns` — per-turn record
- `persistent_agent_turn_logs` — log lines per turn
- `persistent_agent_messages` — inbox (pending + processed)
- `persistent_agent_pods` — per-agent pods, with `keep_warm_until` for
  the cleanup worker

## Open follow-ups

- Native session-resume (`claude --resume <id>`) for context continuity within
  the same agent runtime, when sticky/always-on pods are used.
- Replace the agent-id-as-token shortcut with per-turn signed tokens that
  expire on turn completion.
- A proper stdio MCP server (`@optio/mcp-agents`) wrapping the same HTTP
  verbs, auto-injected into PA pods via `.mcp.json`.
- Per-agent permission scoping for inter-agent messaging (currently
  workspace-wide).
- Repo-mode PAs: long-lived worktrees + the existing Sessions UX as the
  rendering layer for `repo_id`-bound agents.
