# @optio/cli

Terminal-first client for the Optio API. Ships as a standalone `optio` command
installable via `npm install -g @optio/cli` (Node >= 20).

## Install

```bash
npm install -g @optio/cli
```

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
