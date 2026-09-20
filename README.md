# Optio

**Self-hosted AI agent swarm and workflow orchestration platform — your cluster, your machines, your agents, your code.**

[![CI](https://github.com/jonwiggins/optio/actions/workflows/ci.yml/badge.svg)](https://github.com/jonwiggins/optio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Optio runs AI agents as durable, observable, triggerable **sessions** — on Kubernetes pods you operate or on the laptops your team already has — and wires them together into workflows and swarms. It began as a ticket-to-merged-PR pipeline, and it still does that end to end. But the same control plane now runs scheduled reports, webhook responders, event-driven automations on your own machine, interactive agent terminals you can pick up from your phone, and long-lived agents that message each other.

Every kind of work is one noun with five attributes:

| Attribute | The question it answers | Options                                                                                                                                                                                                                          |
| --------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **When**  | What starts it?         | Now · a cron schedule · a webhook · a ticket (GitHub Issues, GitLab Issues, Linear, Jira, Notion) · a GitHub / Slack / Linear event · a message from a person or another agent                                                   |
| **Where** | Where does it run?      | An isolated **Optio pod** in your cluster (with one of your repos checked out, or with no repo) · a directory on **your own machine** via Optio Local (as it is, or on a new branch that becomes a PR)                           |
| **Who**   | What does the work?     | A bare **terminal**, or an agent runtime with its parameters — **Claude Code**, **OpenAI Codex**, **GitHub Copilot**, **Google Gemini**, **Cursor**, **OpenCode**, **OpenClaw** — with the model and provider options you choose |
| **What**  | What is it asked to do? | A prompt, or a saved prompt template with `{{param}}` substitution filled from the trigger payload                                                                                                                               |
| **Then**  | What happens after?     | **Exits when done** (open a PR / produce side effects and stop) · **Waits for you** (an interactive session between turns) · **Persistent agent** (keeps memory, wakes on messages, addressable by other agents)                 |

Pick any combination and Optio derives the right runtime — a repo worktree pod that opens a PR, a pooled job pod, a local terminal, a recurring blueprint, or a long-lived agent — and shows them all in one **Sessions** feed with one status scale: _needs you_ · _running_ · _queued_ · _waiting_ · _scheduled_ · _paused_ · _done_ · _failed_. The New Session form reads back what you've built as a sentence, so you always know exactly what will happen:

> _Started by Linear events, a Claude Code session on my laptop on a new branch in ~/src/app that opens a PR and exits when done._

> _Running weekdays at 09:00 UTC, an OpenAI Codex session in an Optio pod that exits when done._

> _Woken by messages, a Claude Code agent in an Optio pod that keeps its memory between turns._

Under the hood every session state change flows through a [Kubernetes-style reconciliation control plane](./docs/reconciliation.md) — pure decision functions over a frozen world snapshot, applied under compare-and-swap, with periodic resync — so lost events, dead pods, and stalled agents never leave a run stuck.

<p align="center">
  <img src="docs/screenshots/overview.png" alt="Optio overview showing running sessions, completed work, Claude usage limits, active pods, and recent activity" width="100%"/>
</p>
<p align="center"><em>Overview — needs-you queue, usage limits across providers, everything live, and a mixed recent feed</em></p>

<p align="center">
  <img src="docs/screenshots/task-detail.png" alt="Session detail showing live agent logs, pipeline progress through stages (queued, setup, running, PR, CI checks, review, merge, done), and cost tracking" width="100%"/>
</p>
<p align="center"><em>Session detail — live-streamed agent output with pipeline progress, PR tracking, and cost breakdown</em></p>

## What you can run

The five attributes cover a lot of ground. Some shapes Optio runs today, all from the same form and the same feed:

- **Ticket → merged PR.** Assign a GitHub Issue, Linear ticket, or Jira card to Optio. It provisions a pod for the repo, runs the agent in a git worktree, opens a PR, watches CI, launches a review agent, resumes the author agent when CI fails or a reviewer requests changes, and squash-merges when everything is green. ([docs/tasks.md](./docs/tasks.md))
- **Scheduled and webhook-driven agent jobs.** No repo, just a pooled pod: nightly dependency audits, on-call triage from a PagerDuty webhook, a weekly report posted to Slack, a database query rendered into Notion. Parameterized prompts, retries with backoff, cost tracking, log streaming.
- **Recurring blueprints.** Save any pod session as a blueprint and attach triggers; each firing spawns a fresh run with the trigger's payload rendered into the prompt. Blueprints are the **Recurring** view of the feed.
- **Event automations on your own machine.** A `review_requested` on GitHub, an `@mention` in Slack, or a Linear state change spawns Claude Code (or Codex, Cursor, Gemini, OpenCode) in a checkout on your laptop, using your local CLI login — no server secrets ever leave the cluster. Interactive mode halts at the agent's prompt so you can take over; headless mode exits when done and can be resumed later. ([docs/optio-local.md](./docs/optio-local.md))
- **Interactive agent terminals, anywhere.** Open a Claude Code session in a repo pod or on a paired machine, chat with it in the browser or the iOS app, split up to three side by side, and let the layered attention detector (Claude Code hooks → terminal bell → silence) tell you when one **needs you** — as a favicon, a tab count, a push notification, or a Live Activity on your lock screen.
- **Persistent agents and swarms.** Named, long-lived agents with a stable slug, an inbox, and a cyclic turn loop. They wake on user messages, messages from other agents, webhooks, cron ticks, or ticket events, and address each other over an inter-agent HTTP API — enough to build a dispatcher + specialists team. Three pod lifecycle modes trade latency for cost (`always-on` / `sticky` / `on-demand`). ([docs/persistent-agents.md](./docs/persistent-agents.md), [Forge demo](./examples/persistent-agents/forge/), [Mars Mission Control](./examples/persistent-agents/mars-mission-control/))
- **Code review as a first-class session.** A review agent (its own prompt, model, and even vendor) runs as a blocking subtask on PR open or CI pass, for Optio-authored PRs and external ones alike. Reviews have their own surface under **Work → Reviews**.
- **Connections.** Give any session tools: Notion, Slack, Linear, GitHub, PostgreSQL, Sentry, Filesystem, any MCP server, or an HTTP API — injected into the pod at start with per-repo / per-runtime access rules.

## Why Optio?

Hosted agent products — Devin, Cursor background agents, Copilot coding agent, and the rest — will get you a PR faster if you're comfortable shipping your repo to their cloud and betting on their model. Optio's wedge is different: it's the **orchestration layer** you own, running **in your infrastructure**, in front of **whichever agent vendors you trust**, and it orchestrates a lot more than PRs.

| Optio                                                                                                                                                                                                                                                              | Hosted alternatives                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| **Self-hosted** — runs entirely in your Kubernetes cluster (GKE, EKS, AKS, or any conformant K8s) and on machines you pair. Code, secrets, and agent transcripts never leave your network.                                                                         | Hosted SaaS — your code goes to their cloud.                             |
| **Multi-vendor** — Claude Code, OpenAI Codex, GitHub Copilot, Google Gemini, Cursor, OpenCode, and OpenClaw behind one interface. Switch per session, per repo, or A/B two vendors on the same ticket. Live model discovery from each provider's API.              | Locked to one model family or an in-house agent.                         |
| **One model for all agent work** — one-shot PR tasks, scheduled jobs, event automations, interactive terminals, and persistent multi-agent systems share triggers, prompts, connections, the feed, the reconciler, and the cost ledger.                            | PR-centric; ops, automation, and multi-agent use cases are out of scope. |
| **Cluster _and_ laptop** — the same session can run in a pod or in a directory on a developer's machine with their own CLI login, managed from the same UI.                                                                                                        | Cloud-only, or a local tool with no server-side orchestration.           |
| **Open source (MIT)** — read the code, fork it, audit it.                                                                                                                                                                                                          | Closed source.                                                           |
| **Enterprise primitives out of the box** — workspaces with RBAC (admin / member / viewer, enforced on every route and WebSocket), AES-256-GCM secrets at rest, OIDC/OAuth, GitHub App auth, Kubernetes RBAC, audit-friendly history, post-quantum-ready TLS notes. | Vary by vendor; often gated to enterprise tiers.                         |

If none of that matters to you, use a hosted product. If shipping your repo to someone else's cloud is a non-starter, if you want your model choice open, or if "agents" for you means more than a PR bot, Optio is built for you.

## Who is this for?

- **Security-conscious and regulated organizations** — teams that can't (or won't) ship source code, secrets, or production data to a third-party AI service; finance, healthcare, government, defense.
- **Platform teams building internal AI tooling** — Optio is the orchestration layer. You bring the prompts, policies, connections, and review standards; your engineers get one place to start, watch, and be paged by every agent.
- **Teams already running Kubernetes** — drop-in Helm install, BYO Postgres/Redis, integrates with your existing observability, ingress, and identity stack.
- **Multi-agent shops** — evaluating multiple agent vendors, or building systems where agents hand work to each other, and unwilling to commit to a single platform's roadmap.
- **Developers who live in agent terminals** — and want their sessions on the laptop, in the cluster, and on their phone to be the same list.

## How It Works

### One session, derived into the right runtime

```
   WHEN                WHERE                     WHO / WHAT              THEN
   ──────────────      ────────────────────      ─────────────────      ─────────────────
   now                 Optio pod + repo          Claude Code            exits when done
   cron schedule  ──→  Optio pod, no repo   ──→  Codex / Copilot   ──→  waits for me
   webhook              your machine, as is       Gemini / Cursor         persistent agent
   ticket               your machine, branch      OpenCode / OpenClaw
   GitHub/Slack/Linear                            a bare terminal
   messages                                        + prompt / template

                                     ▼

   pod + repo + exits          →  Task: worktree → agent → PR → CI → review → merge
   pod + repo + trigger        →  Blueprint: spawns a Task per firing
   pod, no repo + exits        →  Job run on a pooled pod (+ trigger = recurring Job)
   your machine + trigger      →  Local automation: agent spawned in your checkout
   waits for me                →  Interactive terminal (pod session or local terminal)
   persistent agent            →  Persistent Agent: inbox, turns, inter-agent messaging
```

The mapping is a pure function of the five attributes (`deriveKind` in `apps/web/src/components/session-form/model.ts`), and each branch calls the same service it always did. `/sessions` merges every kind into one feed with views **Active · Recurring · Agents · History**; `/sessions/new` is the single creation form. The per-kind surfaces still exist as detail pages.

### Tasks — ticket to merged PR

```
You create a session       Optio runs the agent           Optio closes the loop
────────────────────       ──────────────────────         ──────────────────────

  GitHub / GitLab Issue     Provision repo pod             CI fails?
  Manual prompt      ──→    Create git worktree    ──→       → Resume agent with failure context
  Linear / Jira / Notion    Run the agent                  Review requests changes?
  Webhook / schedule        Open a PR                        → Resume agent with feedback
                                                           CI passes + approved?
                                                             → Squash-merge + close issue
```

1. **Intake** — the New Session form, the Inbox (GitHub / GitLab Issues across your repos, one-click assign), Linear, Jira, Notion, a webhook, or a schedule.
2. **Provisioning** — Optio finds or creates a long-lived Kubernetes pod for the repo and adds a git worktree, so many sessions share one clone.
3. **Execution** — the runtime runs with your prompt, model, connections, and per-repo settings; logs stream to the UI in real time.
4. **PR lifecycle** — the PR watcher polls CI status, review state, and merge readiness. GitHub, GitLab (incl. self-hosted), and AWS CodeCommit are supported.
5. **Feedback loop** — CI failures, merge conflicts, and review feedback resume the agent with context, capped by `OPTIO_MAX_AUTO_RESUMES`.
6. **Completion** — squash-merge, linked issues closed, cost recorded.

### Jobs — agent work without a repo

```
You define a job            Optio triggers it              Optio runs & tracks
────────────────────        ─────────────────              ───────────────────

  Prompt template           Manual (UI / API)              Pooled job pod (or your machine)
  {{PARAM}} variables  ──→  Cron schedule          ──→     Execute agent with params
  Runtime + model           Webhook from external          Stream logs in real time
  Budget & retry limits     Ticket events                  Track cost & token usage
                                                           Auto-retry with backoff
```

Job pods are shared across runs of the same job (`maxPodInstances × maxAgentsPerPod`), mirroring repo pod scaling.

### Local — sessions on your own machine

```
optio local up  (daemon)    Optio server                   Browser / iOS
──────────────────────      ─────────────────              ──────────────────────

  One outbound WS           Relay frames                   Attach to any terminal
  Directory allowlist  ←──  Route triggers to host  ──→    Split view, needs-you queue
  node-pty terminals        Persist attention state        Resume an exited agent
  Claude Code hooks         Sync linked Task/Job runs      Push / Live Activity
```

Hosts are per-user. Agents on a machine use that machine's own CLI login — the server never ships secrets to laptops. Task and Job runs whose location is `local` are the same rows as cluster runs, executed by a terminal instead of a pod, with the terminal's frames driving the run state (PR link → `pr_opened`, exit → `completed` / `failed`).

### Agents — long-lived, message-driven

```
You create an agent         Wake sources                   Per turn
──────────────────────      ─────────────────              ──────────────────────

  System prompt             User chat message              Drain pending messages
  agents.md operator   ──→  Inter-agent message    ──→     Render into prompt
  manual                    Cron tick / webhook            Run one turn → halt
  Pod lifecycle mode        Ticket event                   Repeat on next wake
```

A Persistent Agent executes one **turn**, halts, and waits. Agents in a workspace can list, message, and broadcast to each other via `/api/internal/persistent-agents/*`, which is what turns a set of agents into a swarm: a dispatcher that fans work out, specialists that report back, a reviewer that closes the loop. See [docs/persistent-agents.md](./docs/persistent-agents.md).

### Connections — tools for every session

Configure a provider once (Notion, GitHub, Slack, Linear, PostgreSQL, Sentry, Filesystem, a custom MCP server, or an HTTP API), assign it to repos or runtimes, and Optio injects the MCP servers into the pod when the session starts.

## Key Features

- **One session model** — When / Where / Who / What / Then; one form, one feed, one status scale across PR tasks, jobs, blueprints, local automations, interactive terminals, and persistent agents
- **Autonomous PR feedback loop** — auto-resume on CI failure, merge conflict, and review feedback; review agent as a blocking subtask; auto-merge and issue close
- **Agent swarms** — persistent agents with inboxes, inter-agent messaging and broadcast, cron/webhook/ticket wake sources, and per-agent pod lifecycle
- **Runs where you want** — pods in your cluster or directories on paired machines, with the same triggers, prompts, and tracking
- **Event triggers** — cron, webhook, ticket sync (GitHub, GitLab, Linear, Jira, Notion), and signed GitHub / Slack / Linear event ingress; trigger payloads render into prompts as `{{params}}` (shell-quoted for local runs, so payloads can never inject commands)
- **Seven runtimes** — Claude Code, OpenAI Codex, GitHub Copilot, Google Gemini, Cursor, OpenCode, OpenClaw, with live model discovery and per-runtime options
- **Attention, not polling** — layered needs-you detection for interactive sessions, surfaced as favicon, tab count, browser notification, iOS push, widgets, Live Activity, and Dynamic Island
- **Usage limits at a glance** — Claude 5-hour / 7-day and per-model limits and Codex rate limits on the Overview and in terminal headers; per-session token and cost chips
- **Connections via MCP** — Notion, Slack, Linear, GitHub, PostgreSQL, Sentry, Filesystem, custom MCP servers, HTTP APIs, with fine-grained assignment
- **Pod-per-repo architecture** — one long-lived pod per repo, git worktree isolation, multi-pod scaling, shared tool caches, idle cleanup
- **Reconciliation control plane** — K8s-style pure-decision + CAS executor with periodic resync over `repo`, `standalone`, `pr-review`, and `persistent-agent` run kinds
- **Workspaces and RBAC** — multi-tenant workspaces; admin / member / viewer enforced on every mutating route and WebSocket
- **Cost analytics** — every run, local session, and agent turn lands in one ledger with daily / repo / kind breakdowns
- **Clients** — web UI, a native iOS app (sessions, terminals, widgets, Live Activity), and a CLI that also hosts the Local daemon

## Architecture

```
┌──────────────┐     ┌────────────────────┐     ┌────────────────────────────┐
│   Web UI     │────→│    API Server      │────→│      Kubernetes            │
│   Next.js    │     │    Fastify         │     │                            │
│   iOS app    │     │                    │     │  ┌── Repo Pod A ────────┐  │
│   CLI        │←ws──│  Workers:          │     │  │ clone + sleep        │  │
│              │     │  ├─ Task Queue     │     │  │ ├─ worktree 1  ⚡     │  │
│  Overview    │     │  ├─ PR Watcher     │     │  │ ├─ worktree 2  ⚡     │  │
│  Work        │     │  ├─ Job Queue      │     │  │ └─ worktree N  ⚡     │  │
│   Sessions   │     │  ├─ Trigger Worker │     │  └──────────────────────┘  │
│   Reviews    │     │  ├─ PA Worker      │     │  ┌── Job Pod ───────────┐  │
│   Inbox      │     │  ├─ Reconciler     │     │  │ pooled agent runs ⚡  │  │
│  Library     │     │  ├─ Health Mon     │     │  └──────────────────────┘  │
│   Prompts    │     │  └─ Ticket Sync    │     │  ┌── Persistent Agent ──┐  │
│   Repos      │     │                    │     │  │ long-lived; turns   ⚡│  │
│   Machines   │     │  Services:         │     │  │ wake on messages     │  │
│   Connections│     │  ├─ Repo Pool      │     │  └──────────────────────┘  │
│  Insights    │     │  ├─ Job Pool       │     │  ┌── Pod Session ───────┐  │
│   Analytics  │     │  ├─ PA Pool        │     │  │ interactive terminal │  │
│   Costs      │     │  ├─ Local Relay    │     │  └──────────────────────┘  │
│   Activity   │     │  ├─ Connections    │     │  MCP servers injected via  │
│   Cluster    │     │  ├─ Review Agent   │     │  Connections at runtime    │
│              │     │  └─ Auth/Secrets   │     └────────────────────────────┘
└──────────────┘     └────┬──────────┬────┘     ┌────────────────────────────┐
                          │          │  ws      │   Your machines            │
                   ┌──────┴──────┐   └─────────→│  optio local up (daemon)   │
                   │  Postgres   │              │  ├─ terminal  ⚡ needs you  │
                   │  Redis      │              │  ├─ automation ⚡ (Linear)  │
                   └─────────────┘              │  └─ Task run  ⚡ → PR       │
                                                └────────────────────────────┘
        ⚡ = Claude Code / Codex / Copilot / Gemini / Cursor / OpenCode / OpenClaw
```

### PR session lifecycle

```
  ┌──────────────────────────────────────────────────┐
  │                     INTAKE                       │
  │                                                  │
  │   Inbox (Issues) ─→ ┌──────────┐                 │
  │   New Session ────→ │  QUEUED  │                 │
  │   Trigger fired ──→ └────┬─────┘                 │
  └───────────────────────────┼──────────────────────┘
                              │
  ┌───────────────────────────┼──────────────────────┐
  │                 EXECUTION ▼                      │
  │                                                  │
  │   ┌──────────────┐    ┌─────────────────┐        │
  │   │ PROVISIONING │───→│     RUNNING     │        │
  │   │ get/create   │    │  agent writes   │        │
  │   │ repo pod or  │    │  code in        │        │
  │   │ local dir    │    │  worktree       │        │
  │   └──────────────┘    └───────┬─────────┘        │
  └───────────────────────────────┼──────────────────┘
                                  │
                ┌─────────────┐   │   ┌──────────────────┐
                │   FAILED    │←──┴──→│    PR OPENED     │
                │             │       │                  │
                │ (auto-retry │       │  PR watcher      │
                │  if stale)  │       │  polls every 30s │
                └─────────────┘       └─────────┬────────┘
                                                │
  ┌─────────────────────────────────────────────┼─────────┐
  │                 FEEDBACK LOOP               │         │
  │                                             │         │
  │   CI fails?  ────────→  Resume agent  ←─────┤         │
  │   Merge conflicts? ──→  Resume agent  ←─────┤         │
  │   Review requests ───→  Resume agent  ←─────┤         │
  │   changes?               with feedback      │         │
  │   CI passes + ───────→  Auto-merge    ──────┤         │
  │   review done?           & close issue      │         │
  │                                             ▼         │
  │                                  ┌──────────────┐     │
  │                                  │ COMPLETED    │     │
  │                                  │ PR merged    │     │
  │                                  │ Issue closed │     │
  │                                  └──────────────┘     │
  └───────────────────────────────────────────────────────┘
```

Persistent agents follow a cyclic machine instead (`idle → queued → provisioning → running → idle`); local terminals follow `pending → launching → running → exited`. All three are reconciled by the same control plane — see [docs/reconciliation.md](./docs/reconciliation.md).

## Quick Start

### Prerequisites

- **Kubernetes v1.33+** — required for post-quantum TLS on the control plane. v1.33 is the first release built on Go 1.24, which enables hybrid X25519MLKEM768 key exchange automatically. Earlier versions run but do not negotiate post-quantum TLS between Optio and the Kubernetes API server.
- **Docker Desktop** with Kubernetes enabled (Settings → Kubernetes → Enable)
- **Node.js 22+** and **pnpm 10+**
- **Helm** (`brew install helm`)

### Setup

```bash
git clone https://github.com/jonwiggins/optio.git && cd optio
./scripts/setup-local.sh
```

That's it. The setup script installs dependencies, builds all Docker images (API, web, and agent presets), deploys the full stack to your local Kubernetes cluster via Helm, and installs metrics-server.

```
Web UI ...... http://localhost:30310
API ......... http://localhost:30400
```

Open the web UI and the setup wizard will walk you through configuring GitHub access, agent credentials (API key, OAuth token, Vertex AI, or a Max/Pro subscription), and adding your first repository. Then hit **New session** and pick a preset — _Open a PR_, _Interactive chat_, _Scheduled run_, or _Persistent agent_ — or compose your own from the five attributes.

### Pair your own machine (optional)

```bash
pnpm --filter @optio/cli build
optio local up            # one outbound WebSocket; advertises a directory allowlist
```

Your machine shows up under **Library → Machines**, and "your machine" becomes an option for **Where** on every new session.

### Updating

```bash
./scripts/update-local.sh
```

Pulls latest code, rebuilds images, applies Helm changes, and rolling-restarts the deployments.

### Teardown

```bash
helm uninstall optio -n optio
```

## Project Structure

```
apps/
  api/          Fastify API server, BullMQ workers (task, job, trigger, PR watcher,
                reconciler, persistent-agent, cleanup), WebSocket endpoints, the
                Local relay, connection / review / secrets services, OAuth
  web/          Next.js UI: Sessions feed + New Session form, Reviews, Inbox,
                Prompts / Repos / Machines / Connections, Insights, local cockpit
  ios/          Native SwiftUI client: sessions, terminals, widgets, Live Activity
  cli/          Terminal client for Optio; hosts the Optio Local daemon (`optio local up`)
  site/         Documentation site (GitHub Pages)

packages/
  shared/             Types, state machines, reconcile decision functions, prompt
                      templates, provider catalog, error classifier
  container-runtime/  Kubernetes pod lifecycle, exec, log streaming (+ a fake runtime for e2e)
  agent-adapters/     Claude Code, Codex, Copilot, Gemini, Cursor, OpenCode, OpenClaw adapters
  ticket-providers/   GitHub Issues, GitLab Issues, Linear, Jira, Notion

images/               Agent container images: base, node, python, go, rust, ruby, dart, full
helm/optio/           Helm chart for production Kubernetes deployment
scripts/              Setup, init, entrypoint, and test-infra scripts
docs/                 Design docs: sessions/tasks, persistent agents, Optio Local,
                      reconciliation, cryptography, observability, iOS push
examples/             Runnable example sessions: PR tasks, jobs, multi-agent swarms
```

## GitHub App Setup

Optio can use a [GitHub App](https://docs.github.com/en/apps/creating-github-apps) instead of a Personal Access Token for GitHub operations. This provides user-scoped access (respecting CODEOWNERS, branch protection, and repository permissions), automatic token refresh, and clear attribution on PRs and commits.

### Creating the GitHub App

Register a new GitHub App at `https://github.com/organizations/{org}/settings/apps/new` with these settings:

**Repository permissions:**

| Permission    | Access       | Used for                           |
| ------------- | ------------ | ---------------------------------- |
| Contents      | Read & Write | git clone, push, branch management |
| Pull requests | Read & Write | create PRs, post comments, merge   |
| Issues        | Read & Write | issue sync, label management       |
| Checks        | Read         | CI status polling in PR watcher    |
| Metadata      | Read         | repo listing, auto-detection       |

**Account permissions:**

| Permission      | Access | Used for                           |
| --------------- | ------ | ---------------------------------- |
| Email addresses | Read   | user email for login (recommended) |

**Organisation permissions:**

| Permission | Access | Used for                |
| ---------- | ------ | ----------------------- |
| Members    | Read   | repo listing (optional) |

**Other settings:**

- **Callback URL:** `{PUBLIC_URL}/api/auth/github/callback`
- **Request user authorization (OAuth) during installation:** Yes
- **Expire user authorization tokens:** Yes (recommended, 8-hour lifetime with refresh)
- **Webhook:** Optional. PR tracking uses polling; the signed GitHub event receiver is only needed for GitHub event triggers on local automations.

### Configuration

After creating the app and installing it on your organisation, configure Optio via Helm values:

```yaml
github:
  app:
    id: "123456" # App ID (from app settings page)
    clientId: "Iv1.abc123" # Client ID (for user OAuth login)
    clientSecret: "..." # Client secret
    installationId: "789" # Installation ID (from org install URL)
    privateKey: | # PEM private key (for server-side tokens)
      -----BEGIN RSA PRIVATE KEY-----
      ...
      -----END RSA PRIVATE KEY-----
```

When configured, users who log in via GitHub get a user access token that is used for all their git and API operations. Background workers (PR watcher, ticket sync) use the app's installation token. If the GitHub App is not configured, Optio falls back to the `GITHUB_TOKEN` PAT.

### Using an existing secret

If you manage secrets externally (e.g., with [external-secrets-operator](https://external-secrets.io/), sealed-secrets, or vault-injector), you can reference an existing Kubernetes Secret instead of providing the values inline:

```yaml
github:
  app:
    existingSecret: "my-github-app-secret"
```

The secret must contain these keys: `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`.

## Production Deployment

Optio ships with a Helm chart for production Kubernetes clusters. Three installation methods are available:

### Install from Helm repository (recommended)

```bash
helm repo add optio https://jonwiggins.github.io/optio
helm repo update
helm install optio optio/optio -n optio --create-namespace \
  --set encryption.key=$(openssl rand -hex 32) \
  --set postgresql.enabled=false \
  --set externalDatabase.url="postgres://..." \
  --set redis.enabled=false \
  --set externalRedis.url="redis://..." \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=optio.example.com
```

### Install from OCI registry

```bash
helm install optio oci://ghcr.io/jonwiggins/optio -n optio --create-namespace \
  --set encryption.key=$(openssl rand -hex 32) \
  --set postgresql.enabled=false \
  --set externalDatabase.url="postgres://..." \
  --set redis.enabled=false \
  --set externalRedis.url="redis://..." \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=optio.example.com
```

### Install from source

```bash
git clone https://github.com/jonwiggins/optio.git && cd optio
helm install optio helm/optio -n optio --create-namespace \
  --set encryption.key=$(openssl rand -hex 32) \
  --set postgresql.enabled=false \
  --set externalDatabase.url="postgres://..." \
  --set redis.enabled=false \
  --set externalRedis.url="redis://..." \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=optio.example.com
```

See the [Helm chart values](helm/optio/values.yaml) for full configuration options including OAuth providers, resource limits, and agent image settings.

## Documentation

| Doc                                                      | What it covers                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [docs/tasks.md](./docs/tasks.md)                         | The session model, how the five attributes map to storage kinds, the `/api/tasks` API |
| [docs/persistent-agents.md](./docs/persistent-agents.md) | Long-lived agents, turns, inboxes, inter-agent messaging, pod lifecycle modes         |
| [docs/optio-local.md](./docs/optio-local.md)             | The Local daemon, terminals, attention detection, automations, local Task/Job runs    |
| [docs/reconciliation.md](./docs/reconciliation.md)       | The control plane: snapshot, decisions, CAS executor, resync                          |
| [docs/observability.md](./docs/observability.md)         | Logs, metrics, health events                                                          |
| [docs/cryptography.md](./docs/cryptography.md)           | Secrets at rest, session tokens, TLS                                                  |
| [docs/ios-push.md](./docs/ios-push.md)                   | APNs push, widgets, Live Activity                                                     |
| [examples/](./examples/README.md)                        | Runnable examples: PR tasks, jobs, and multi-agent swarms                             |
| [CHANGELOG.md](./CHANGELOG.md)                           | Release notes                                                                         |

## Tech Stack

| Layer    | Technology                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------- |
| Monorepo | Turborepo + pnpm                                                                                     |
| API      | Fastify 5, Drizzle ORM, BullMQ                                                                       |
| Web      | Next.js 15, Tailwind CSS 4, Zustand, xterm.js                                                        |
| iOS      | SwiftUI, WidgetKit, ActivityKit; models generated from the shared TypeScript types                   |
| CLI      | Node, node-pty (Local daemon)                                                                        |
| Database | PostgreSQL 16                                                                                        |
| Queue    | Redis 7 + BullMQ                                                                                     |
| Runtime  | Kubernetes (Docker Desktop for local dev) + paired machines                                          |
| Deploy   | Helm chart                                                                                           |
| Auth     | Multi-provider OAuth (GitHub, Google, GitLab, generic OIDC), GitHub App, PATs                        |
| CI       | GitHub Actions (format, typecheck, unit, integration, pipeline e2e, web e2e, build-web, build-image) |
| Agents   | Claude Code, OpenAI Codex, GitHub Copilot, Google Gemini, Cursor, OpenCode, OpenClaw                 |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, workflow, and conventions.

## License

[MIT](./LICENSE)
