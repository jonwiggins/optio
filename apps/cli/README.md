# @optio/cli

Terminal-first client for the Optio API. Ships as a standalone `optio` command
(Node >= 20).

## Install

`@optio/cli` isn't published to npm yet — build it from a checkout of this repo:

```bash
pnpm install --filter "@optio/cli..." && pnpm --filter @optio/cli build
alias optio="node $PWD/apps/cli/dist/optio.js"   # from the repo root
```

The web UI's **Machines → Add machine** shows these steps with your server's URL filled in.

## Quickstart

```bash
# Login (opens browser for OAuth)
optio login --server https://optio.example.com

# Create a task
optio task new https://github.com/acme/repo "Fix the bug"

# Stream logs
optio task logs <id> --follow

# List running tasks
optio task list --state running

# Interactive session
optio session new https://github.com/acme/repo
optio session attach <id>
```

## Local session usage

`optio local up` reads Claude Code transcripts and Codex rollouts to report each
session's tokens and estimated cost. The dollar pill uses public API list prices,
including cached input, and is an API-equivalent estimate for subscription sessions.
It is the cost of recorded work so far, not a prediction of the remaining work.
Unknown model prices are left unavailable. OpenAI rates are recorded in
`packages/shared/src/utils/agent-usage.ts` with their verification date.

Rebuild the CLI to receive usage-tracking updates. An already-running daemon keeps
its loaded code until restarted; restarting it stops the terminals it owns, so
finish or save active work first.

## Authentication

### Browser OAuth (interactive)

```bash
optio login --server https://optio.example.com
```

Opens your browser to complete OAuth. Credentials are stored in
`~/.config/optio/credentials.json` (mode 0600).

### API key (headless / CI)

Set `OPTIO_TOKEN` environment variable. Create API keys in the Optio web UI
under Settings > API Keys, or via the CLI after logging in.

```bash
export OPTIO_TOKEN=optio_pat_...
export OPTIO_SERVER=https://optio.example.com
optio task new https://github.com/acme/repo "Add tests"
```

Token resolution order:

1. `--api-key <token>` flag
2. `OPTIO_TOKEN` env var
3. `~/.config/optio/credentials.json`

## CI Usage

```yaml
- env:
    OPTIO_TOKEN: ${{ secrets.OPTIO_TOKEN }}
    OPTIO_SERVER: https://optio.example.com
  run: |
    npm i -g @optio/cli
    optio task new "${{ github.event.repository.html_url }}" \
      "Add unit tests" --agent claude-code --wait --json > task.json
    jq -r '.task.prUrl // empty' task.json
```

## Commands

### Global flags

Every command supports: `--server <url>`, `--api-key <token>`,
`--workspace <slug>`, `--json`, `--no-color`, `--verbose`, `-h/--help`.

### Auth

| Command        | Description                    |
| -------------- | ------------------------------ |
| `optio login`  | Authenticate via browser OAuth |
| `optio logout` | Log out and revoke token       |
| `optio whoami` | Show current user and server   |

### Tasks

| Command                            | Description                  |
| ---------------------------------- | ---------------------------- |
| `optio task new <repo> "<prompt>"` | Create a task                |
| `optio task list`                  | List tasks                   |
| `optio task show <id>`             | Show task details            |
| `optio task logs <id> [-f]`        | View/stream logs             |
| `optio task message <id> "<msg>"`  | Send message to running task |
| `optio task cancel <id>`           | Cancel a task                |
| `optio task retry <id>`            | Retry a failed task          |
| `optio task review <id>`           | Trigger code review          |

### Repos

| Command                  | Description         |
| ------------------------ | ------------------- |
| `optio repo list`        | List repositories   |
| `optio repo show <id>`   | Show repo details   |
| `optio repo add <url>`   | Add a repository    |
| `optio repo remove <id>` | Remove a repository |

### Sessions

| Command                     | Description                |
| --------------------------- | -------------------------- |
| `optio session new <repo>`  | Create interactive session |
| `optio session list`        | List sessions              |
| `optio session attach <id>` | Attach to terminal         |
| `optio session end <id>`    | End a session              |

### Secrets

| Command                           | Description     |
| --------------------------------- | --------------- |
| `optio secret list`               | List secrets    |
| `optio secret set <name> [value]` | Set a secret    |
| `optio secret rm <name>`          | Remove a secret |

### Workspaces

| Command                         | Description      |
| ------------------------------- | ---------------- |
| `optio workspace list`          | List workspaces  |
| `optio workspace switch <slug>` | Switch workspace |

### Config as code

Resources as YAML manifests (`docs/config-as-code.md`): export what a
workspace has, apply a file or a directory, see what an apply would change.

| Command                                       | Description                                                    |
| --------------------------------------------- | -------------------------------------------------------------- |
| `optio export [--kind k] [--name n] [-o DIR]` | Export the organization's resources; `-o` writes one file each |
| `optio apply -f FILE\|DIR... [--dry-run]`     | Create or update the resources the manifests describe          |
| `optio diff -f FILE\|DIR...`                  | What `apply` would change (a dry run)                          |
| `optio schema`                                | The JSON Schema manifests validate against                     |

A CLI apply is a plain upsert: it manages nothing and never prunes. A cluster
that should keep a directory applied mounts it as `OPTIO_CONFIG_DIR` (Helm
`configAsCode.*`). Exit code 1 when any manifest failed.

### Other

| Command                     | Description                  |
| --------------------------- | ---------------------------- |
| `optio config show/set/get` | Manage CLI config            |
| `optio version`             | Show CLI and server versions |

## Exit codes

| Code | Meaning                      |
| ---- | ---------------------------- |
| 0    | Success                      |
| 1    | Generic failure              |
| 2    | Authentication failure (401) |
| 3    | Authorization failure (403)  |
| 4    | Network/server unreachable   |
| 5    | Validation failure (400)     |
| 130  | Interrupted (SIGINT)         |
