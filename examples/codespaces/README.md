# A dev container GitHub Codespaces work runs in

The configuration a repository needs so that a codespace Optio creates for
a piece of work pairs itself with Optio as a machine
([docs/remote-workspaces.md](../../docs/remote-workspaces.md), "GitHub
Codespaces").

```
codespaces/
  .devcontainer/
    devcontainer.json   # Node.js 20, git, the agent CLIs; runs optio-pair.sh on every start
    optio-pair.sh       # reads the codespace's pairing secret and runs Optio's start script
  README.md
```

Copy `.devcontainer/` into the repository (or merge it into the dev
container it already has: what matters is the `postStartCommand`). Then, in
Optio, **Settings → Integrations → Remote workspaces → Add connection →
GitHub Codespaces** with your own personal access token (a Codespaces
connection is a person's own), and pick **Where → A remote workspace** in
New work.

## What happens

1. Optio creates the codespace (`POST /repos/{owner}/{repo}/codespaces`) for
   the work's repository and writes the pairing bundle into the Codespaces
   user secret `OPTIO_PAIRING_<NAME>` — the codespace's name in capitals,
   other characters as `_` — visible to that repository only, sealed with
   your Codespaces public key.
2. The codespace starts, GitHub exports the secret into it, and
   `optio-pair.sh` decodes it and runs `GET $OPTIO_SERVER/api/cli/workspace-start.sh`:
   the agent policy (with `sudo`, which the dev container image allows), the
   Optio CLI from the server, and `optio local up` in the checkout
   (`/workspaces/<repository>`).
3. The daemon says hello; Optio deletes the secret, and the run starts.
4. When the work is done Optio stops (or deletes) the codespace; a re-run
   writes a fresh secret and starts it again.

The codespace must reach Optio at its public URL. GitHub stops a codespace
after its idle timeout (no terminal or editor activity; at most 4 hours),
which a long run without either can hit: set the connection's "Stop after"
to the longest run.
