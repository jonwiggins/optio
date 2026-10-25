# Optio controller MCP

The controller serves MCP at **`/api/mcp`** using stateless Streamable HTTP.
Agents can discover work, create and schedule it, inspect results and logs,
and exchange direct messages among persistent agents and active task/Job agents. Every request authenticates
independently, so clients work across API replicas without sticky sessions.

## Connect your own agent

**Settings → Access → Connect your agent** does the whole thing: pick the
client, press _Create a token for this agent_ (a personal access token named
`MCP: <client>`, shown once), and copy the command or config it fills in.
For Claude Code on your laptop that is one line:

```sh
claude mcp add --transport http optio https://optio.example.com/api/mcp \
  --header "Authorization: Bearer optio_pat_REPLACE_ME" \
  --header "X-Workspace-Id: YOUR_WORKSPACE_UUID"
```

or the same entry in `~/.claude.json` / a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "optio": {
      "type": "http",
      "url": "https://optio.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer optio_pat_REPLACE_ME",
        "X-Workspace-Id": "YOUR_WORKSPACE_UUID"
      }
    }
  }
}
```

OpenCode takes the same URL and headers as a `remote` server in
`opencode.json` (`"mcp": { "optio": { "type": "remote", … } }`). The URL is
the API as your browser reaches it (`PUBLIC_API_URL`, else the web origin,
whose `/api/mcp` the web proxy passes through); the card warns when that is
a localhost address another computer cannot use. On a network with no
internet access the agent has to run inside that network. Once connected, the agent can
create work — on a schedule, on a webhook, or right now — run it, read its
runs and logs, manage triggers and prompts, and message the agents Optio
runs, all with your workspace permissions.

Any other client takes a remote MCP server with:

```json
{
  "url": "https://optio.example.com/api/mcp",
  "headers": {
    "Authorization": "Bearer optio_pat_REPLACE_ME",
    "X-Workspace-Id": "YOUR_WORKSPACE_UUID"
  }
}
```

The workspace header is optional; without it, the key uses your default
workspace. Membership and role are checked on every request. Viewers receive
only read tools. Members and admins can manage organization work and their
own private work; admins can inspect other private work but cannot run it
with somebody else's credentials. Use TLS outside local development. Tokens
remain revocable under API keys. OAuth client registration and the legacy
SSE transport are not implemented; use a client that supports bearer headers
or the stdio adapter below.

For this repository's local deployment, the endpoint is
`http://localhost:30310/api/mcp` through the web proxy, or
`http://localhost:30400/api/mcp` directly. When authentication is disabled,
omit Authorization. An invalid supplied credential is still rejected.
Cookies do not authenticate MCP requests. Browser origins are checked.

For clients that support only stdio, the card's _Other (stdio)_ tab offers
**Download optio-controller-mcp.js**: the bundled adapter
(`packages/mcp-bridge`, one file, Node 20 or newer), served by
`GET /api/downloads/controller-mcp.js`. The API finds it at
`OPTIO_MCP_BRIDGE_DIST` (the file or its directory), else
`/opt/optio/controller-mcp.js`, else the package's `dist` in a source
checkout, and answers 404 saying so when none exists — on a connected
machine, `pnpm --filter @optio/mcp-bridge build` makes it. Configure it
with the file's absolute path:

```json
{
  "mcpServers": {
    "optio": {
      "command": "node",
      "args": ["/path/to/optio-controller-mcp.js"],
      "env": {
        "OPTIO_MCP_URL": "https://optio.example.com/api/mcp",
        "OPTIO_MCP_TOKEN": "optio_pat_REPLACE_ME",
        "OPTIO_WORKSPACE_ID": "YOUR_WORKSPACE_UUID"
      }
    }
  }
}
```

The adapter fetches tool definitions from the controller and relays calls;
there is one tool catalog. Keep the token in your client's secret storage
when it supports that instead of committing a config file.

## Give Optio's own agents access

Create or edit work and open **Where → Environment → Optio controller**:

- **Off** (default): no controller tools.
- **Read work and results**: discovery, configuration, results, logs, inboxes.
- **Manage work and message agents**: also create/edit work, run definitions,
  enable or pause them, manage schedules, and send direct messages.

The API representation is `settings.controllerAccess: "off" | "read" | "manage"`.
It works for repo tasks, scheduled tasks, Jobs and persistent-agent turns.
Claude Code, Codex, Gemini, OpenCode, Copilot and Cursor receive the adapter
through the same runtime-specific MCP configuration as other connections.
Shell-only work and untrusted review workers receive no controller credential.
For existing persistent agents, open **Configuration → Optio controller**.
The persistent-agent PATCH API accepts `controllerAccess` too, preserving
the rest of its environment. For agents created through MCP or a config-as-code
Work manifest, use `settings.controllerAccess` in the WorkSpec.

Credentials are per run/turn, signed with a key available only to the API,
expire after 24 hours, and are checked against the run's active state on
every request. Redis records the current grant so issuing another invalidates
the previous attempt. Completion, cancellation intent, permission removal,
workspace/owner changes, or removing the owner's membership revokes access.
A long run must start a fresh attempt after expiry. Credentials work only
at `/api/mcp`; they cannot call the ordinary REST API, read secrets, switch
workspaces, become an admin, or operate another person's private work.

Organization work sees organization resources; private work sees its owner's
resources and organization resources. Child work created by a run keeps the
same owner and defaults to controller access **off**. A managing agent may
explicitly delegate controller access when it creates child work; it cannot
change the workspace or give the child another person’s identity. Tool writes appear in
the Activity audit with the calling run/agent id; prompts, messages and tokens
are not copied into the audit.

## Tools

| Tool                                           | Purpose                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `optio_context`                                | Identity, workspace, access and usage instructions                                                  |
| `optio_list_work` / `optio_get_work`           | Discover work; inspect configuration, state, results, PR checks and usage                           |
| `optio_list_repos`                             | Find configured repositories and default branches                                                   |
| `optio_create_work` / `optio_update_work`      | Create work or replace a recurring definition's attributes                                          |
| `optio_run_work`                               | Start an enabled recurring definition with template parameters                                      |
| `optio_set_work_enabled`                       | Pause or enable future runs; existing runs finish                                                   |
| `optio_list_triggers`                          | Inspect triggers, secrets omitted                                                                   |
| `optio_set_schedule` / `optio_delete_schedule` | Add, update, pause or remove a cron schedule                                                        |
| `optio_list_runs`                              | Prior task/Job runs, persistent-agent turns or PR-review runs and results                           |
| `optio_get_run_logs`                           | Bounded, paginated run logs with optional text/type filters                                         |
| `optio_list_agents`                            | Discover persistent agents and active task/Job agents, including runtime, address and delivery mode |
| `optio_send_message`                           | Queue a direct message; wake a persistent recipient or place it in an active run’s inbox            |
| `optio_get_session_history`                    | Read recent saved messages from your pod or Local conversations (interactive operators only)        |
| `optio_send_session_message`                   | Continue an existing interactive conversation through its chat input (interactive operators only)   |
| `optio_read_inbox`                             | Read your own or another visible agent’s inbox, including reply addresses                           |

Lists accept `limit` (1–100, default 25) and `offset`; follow `nextOffset`.
Log lines mark truncation after 8000 characters. Responses are capped at
300,000 characters; use smaller pages or a log filter for large results.
Logs and received messages are data from other actors, not trusted controller
instructions. Tool descriptions and MCP instructions make this distinction.

For a Local run, `optio_get_run_logs` defaults to its saved conversation,
the same transcript the frontend displays, including tool details. Use
`source: "execution"` for its lifecycle and error logs instead. `get_work`
and `list_runs` include `runTarget` and `localTerminalId`, so an interactive
operator can continue the linked session with `send_session_message`.
The linked terminal must match the run's workspace and owner. A run that
has not acquired a terminal yet still returns its execution logs.

Writes use the existing work/trigger/run services and execution admission
checks, including usage budgets. They are asynchronous: keep the returned
work, run or message id and inspect progress. Calls are not automatically
retried and mutations are not idempotent; after a lost response, check the
work list/inbox before issuing another create, run or message call.

## Example: schedule a daily review

Call `optio_create_work` with:

```json
{
  "spec": {
    "name": "Daily results review",
    "when": {
      "type": "schedule",
      "config": {
        "cronExpression": "0 9 * * 1-5",
        "timezone": "America/Denver"
      }
    },
    "where": { "runTarget": "cluster" },
    "who": { "runtime": "claude-code" },
    "what": { "prompt": "Review yesterday's work results and summarize failures and follow-ups." },
    "then": "exits",
    "settings": { "controllerAccess": "read" }
  }
}
```

This call explicitly grants the Job read access. When a managing agent
makes it, the Job keeps that agent’s work owner and workspace. Schedules use cron plus an IANA timezone (UTC by default)
and honor daylight saving time. Schedule edits in the Work form preserve
the timezone. A manual Job starts immediately; a scheduled one waits for
its trigger. Use `optio_run_work` to test it now, then `optio_list_runs` and
`optio_get_run_logs` to inspect the result.

## Collaborate across agent types

`optio_list_agents` includes persistent agents and active pod task/Job runs
with controller access enabled. Filter by `kind` (`persistent-agent`,
`repo-task`, `job-run`) or `runtime` (`codex`, `gemini`, `claude-code`, etc.).
Each entry includes its `address`, runtime, state, `controllerAccess`,
`canMessage`, and delivery mode. A sender needs **Manage** access; a recipient
needs **Read** to check its inbox and **Manage** to reply.

Call `optio_send_message` with an entry’s address:

```json
{ "to": "RECIPIENT_ADDRESS", "body": "Please review the API contract for my run." }
```

Persistent-agent slugs still work. An active run's address is its run UUID,
not its recurring definition's id. `optio_context` includes your own address.
Messages carry their authenticated sender's name and a `replyTo` address;
call `optio_send_message` with that address to respond. This works between
tasks, Job runs and persistent agents, regardless of their CLI runtime.

Delivery is explicit:

- **`wake`**: a persistent agent consumes the message in a turn, starting a
  turn when it is available.
- **`inbox`**: a task or Job run receives a durable message in its run inbox.
  It must call `optio_read_inbox` to see it. Omit `agent` to read your own
  inbox. Controller instructions ask agents to check at the start, at
  collaboration checkpoints, and before finishing. Sending does not interrupt
  the runtime or restart a stopped run.

The receipt means queued, not read or answered. Reading does not acknowledge
that the message was acted on. Finished runs reject new messages; authorized
people can still inspect their history. Paused, disabled, foreign and other
people's private recipients are rejected. Existing user-to-task messages share
the run inbox and keep their original user attribution.

A shared message board is not part of this surface yet. Direct messages are
addressed to one recipient; they do not broadcast to the workspace.

The Optio assistant is one saved interactive conversation per user and workspace,
shared by the web and native apps. Its prompt is refreshed from current guidance
on each turn. New interactive conversations use `then: "waits-for-me"`; only an
explicitly requested long-lived message-driven agent uses `waits-for-messages`.
Scheduling belongs to When and does not require a persistent agent. Mutation tools
show an approval card when confirmation is enabled; the assistant should call the
tool directly, without asking for an additional yes in chat.

Interactive operators can discover their own pod and Local sessions via
`optio_list_work` / `optio_get_work`. `canMessage` describes whether that session
supports input in its current state. `optio_get_session_history` returns the latest
saved entries (up to 100, each capped at 2000 characters). It also reads finished
sessions. `optio_send_session_message` uses the same transport as the chat UI:
harness pod sessions queue durably, legacy pod chats use their existing Claude
resume session, and Local agent chats send text and Enter to the daemon. A Local
receipt means input was sent, not that an agent has replied; check history later.
Pod messages accept a stable `requestId` UUID to prevent duplicate delivery.
Never resend an uncertain Local delivery automatically. These tools preserve exact
workspace and owner boundaries, including for admins, and reject self-input,
finished sessions and shell-only Local terminals. Headless run credentials cannot
use interactive session tools.

Arbitrary machine control, broadcasts, PR submission/merge actions and credential
administration remain outside the MCP tool surface.

## Frontend parity review — 2026-10-18

The [endpoint inventory](audits/controller-mcp-parity-2026-10-18.csv) compares the
web client at `61a57c04` with the controller tools at that commit. It covers all
293 API helpers, including 271 referenced by non-test frontend code. References
were collected from TypeScript property-access expressions, including multiline
calls and callbacks; HTTP methods and URL expressions were matched to the live
OpenAPI document's 342 operations. Two helpers return download URLs instead of
calling `request`. Counts are client helpers, not distinct backend capabilities,
and the CSV records the baseline before the Local-log correction above.

At the audited baseline, the assistant had 19 tools; other agents and PAT clients
had 16. Session-only tools were machine discovery, session history and session
input. That baseline was **not frontend parity**. A tool with a similar name can still omit configuration,
restrict a work kind, read a different store, or lack an interaction mode.

| Area                             | Baseline coverage                                  | Remaining gaps                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work discovery and configuration | Basic list, details, creation, recurring edits     | Local definitions are omitted/rejected; incomplete filters/configuration; work environment, model and credential-reference discovery                                                           |
| Run lifecycle                    | Start a pod definition; pause its triggers         | Cancel, retry, resume, force restart/redo, prioritization, delete/clone, Local run controls                                                                                                    |
| Scheduling and events            | List triggers; create/update/delete cron schedules | Other trigger types, parameter mappings, delivery history/retry, outbound webhooks                                                                                                             |
| Conversations                    | Agent inboxes; owned session history/input         | Earlier history pagination, session interruption, queued-message cancellation, session model changes, session lifecycle and PR links; task soft/interrupt modes differ from MCP inbox delivery |
| Reviews and Inbox                | Review summaries, runs and logs                    | Draft/edit/submit/cancel/re-run reviews, review chat, PR status/merge, issue assignment and synchronization                                                                                    |
| Work collaboration               | Direct agent messages                              | Comments, activity/events, subtasks/dependencies, sharing/recovery, bulk actions                                                                                                               |
| Library and environment          | Repository identifiers and default branches        | Prompt CRUD/preview; repository settings; connections/assignments; MCP servers; skills/marketplace sync; shared directories                                                                    |
| Operations and settings          | Controller identity and access                     | Usage/analytics/budgets, machine management, cluster controls, notification preferences, assistant settings, config-as-code, workspace administration                                          |

The Local-log mismatch was reproduced live: a Local run had 52 persisted
transcript entries, while `optio_get_run_logs` returned zero. The correction reads
the linked conversation, exposes the terminal ID, preserves execution logs as an
explicit source, and tests owner/workspace checks, pagination and tool details.
Agent detail also now includes saved prompts, model/options, repository reference
and environment settings instead of only its description/runtime.

WebSocket review is separate from HTTP coverage: pod and assistant chats support
message, interrupt, model selection, approval/denial and queue cancellation;
terminal sockets additionally carry input, resize and viewer-presence frames.
Resize, clipboard, notification enrollment and OAuth redirects are client
mechanisms, not independent agent tasks. Approval decisions must remain with the
human: adding an MCP operation that approves the caller's own requests would
defeat the approval gate.

For remaining parity work, use an explicit capability registry tied to the existing
OpenAPI operation IDs and shared services. Each entry needs its input schema,
workspace/owner and role policy, read/write classification, approval summary and
output redaction. Keep common work actions as small typed tools; let the agent
discover less-common actions on demand. An unrestricted HTTP proxy would bypass
the existing controller boundary. The Optio assistant should act with its user's
current permissions, while delegated work keeps its assigned controller grant
and owner; having `manage` access must not make a background agent an admin.

Acceptance should cover whole UI workflows, not tool-name counts: create and
continue interactive work; inspect a Local run's actual transcript; cancel and
retry failed work; edit every trigger type; manage prompts/environment; and
review/submit work. For each mutation verify one approval, authorization again
after approval, denial without a side effect, and correct owner/workspace scope.
A new frontend endpoint should require either a tested capability mapping or an
explicit documented exclusion in the registry.

## Workflow and library expansion

The first expansion follows the agreed scope: work, conversations, reviews and
the prompt library. Administration stays in Settings. The baseline CSV above is
historical; it is not a claim that newly implemented operations are still missing.

| Tools                                                                                             | Frontend operations now available                                                                                                                             |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `control_run`                                                                                     | Cancel/retry task and Job runs; resume or restart tasks, force redo and override the off-peak hold. Task HTTP routes and MCP share `task-control-service.ts`. |
| `delete_work`, `control_agent`                                                                    | Delete recurring definitions; pause/resume/archive/restart persistent agents.                                                                                 |
| `create_trigger`, `update_trigger`, `delete_trigger`                                              | Event triggers, parameter mappings, enabled state, cron and webhook configuration using the common trigger service. Review schedules are supported too.       |
| `get_session_history`, `control_session`                                                          | Follow `nextBeforeSeq` to read older messages; interrupt/end owned sessions or cancel queued pod messages.                                                    |
| `list_prompts`, `get_prompt`, `preview_prompt`, `create_prompt`, `update_prompt`, `delete_prompt` | Browse, render and manage reusable prompt templates. New prompts inherit the caller's owner.                                                                  |
| `get_environment`, `get_models`                                                                   | Discover usable connection/MCP/skill references and runtime model/options. Raw commands, credentials and setup scripts are omitted.                           |
| `create_review`, `update_review`, `control_review`                                                | Launch reviews, edit ready/stale drafts, cancel/re-review and submit the draft to the git provider.                                                           |
| `get_review_chat`, `send_review_message`, `get_pr_status`, `merge_pr`                             | Read/continue review conversations, inspect PR checks and merge the PR attached to a task or review.                                                          |
| `get_task_activity`, `write_task_comment`                                                         | Read task events/comments; add comments and edit/delete the caller's own comments.                                                                            |

Interactive operators can now discover, edit, enable/disable, run and delete
their own Local recurring definitions. Their run history returns terminal ids
for the session-history tool. Background run credentials still cannot operate
machines or private interactive sessions. All new writes use the existing
single approval card, recheck authorization after approval, and obey controller
read/manage grants and the assistant's per-tool allowlist.

Credential administration is excluded. MCP refuses trigger `config.secret`;
Pylon, Alertmanager and Datadog triggers must initially be created in the UI so a
person receives the one-time secret. MCP can edit their filters or enabled state
without returning or replacing the stored secret. Integration setup, repository
administration, workspace membership, cluster management and sign-in settings
remain in Settings/their existing administrative UI.

Remaining workflow differences are explicit: issue assignment/synchronization,
trigger delivery inspection/retry, task subtasks/dependencies and bulk edits,
session model switching/sharing/recovery/PR links, and persistent-agent
configuration edits beyond lifecycle controls. The inventory retains these as
follow-up work; this release expands the core workflows without claiming every
frontend operation is covered. Client-only interactions (resize, clipboard,
viewer presence and device enrollment) and human approval decisions are not MCP
operations.
