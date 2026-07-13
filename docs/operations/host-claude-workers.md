# Host-Claude Workers Runbook

Operating Optio agent workers that authenticate Claude Code with **host-mounted Claude credentials** instead of injected API keys, on a K3s cluster.

## Purpose

Host-Claude mode lets repo-pod workers run Claude Code using the Claude configuration that already lives on the K3s node (e.g., a Max subscription login), so no Anthropic secret has to be stored in Optio or injected into pods. This runbook covers dispatching a task in this mode, verifying it worked, and diagnosing the common failure points.

## Prerequisites

- A K3s node with a working Claude Code login in the host user's Claude config directory (`~/.claude`). Verify with `claude -p "ok"` as that user on the host.
- The agent image built locally and **imported into K3s/containerd**. A local `optio-base:latest` must be visible to the K3s containerd CRI, not just Docker, before repo pods can start:

  ```bash
  docker save optio-base:latest | sudo k3s ctr images import -
  sudo k3s crictl images | grep optio-base   # must list the image
  ```

- `OPTIO_IMAGE_PULL_POLICY=Never` (or Helm equivalent) so K3s uses the imported local image.
- The host Claude config directory exposed to the cluster (hostPath volume) on the node(s) where repo pods schedule.

## Dispatch flow

1. Optio schedules the task and provisions (or reuses) the repo pod on a node with the host Claude mount.
2. The pod mounts the host Claude config **read-only**. Before Claude Code starts, the entrypoint copies it into the writable worker `$HOME` (Claude Code needs to write session state, so it can never run against the read-only mount directly).
3. In host-Claude mode the worker env must **not** contain `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` — either one overrides the copied host login and defeats the purpose of this mode.
4. The worker creates a git worktree for the task branch, runs Claude Code with the task prompt, commits, pushes, and opens the PR.
5. The PR watcher takes over: CI tracking, review triggering, and completion on merge.

## Verification checklist

- [ ] Task reached `running` and streamed agent logs to the web UI (no auth prompt or login error at Claude Code startup).
- [ ] Worker env is clean: `kubectl exec` into the repo pod and confirm `env | grep -E 'ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN'` returns nothing.
- [ ] Copied Claude config exists in the worker `$HOME` and is writable (not the read-only mount path).
- [ ] Branch was pushed and a PR was opened against `main`.
- [ ] Task transitioned to `pr_opened`, and `GET /api/auth/status` reports the expected auth mode.

## Troubleshooting notes

| Symptom                                                | Likely cause / fix                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pod stuck in `Pending`/`ErrImageNeverPull`             | `optio-base:latest` exists in Docker but not in containerd. Re-run the `k3s ctr images import` step and confirm with `crictl images`.                              |
| Claude Code exits with "not logged in" / auth error    | Host config missing on that node, hostPath mount wrong, or the copy into `$HOME` failed. Check the pod's mount and the entrypoint copy step in pod logs.           |
| Claude Code uses the wrong account or billing          | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` leaked into the worker env (secret assignment or Helm value). Remove it — host mode forbids both.                 |
| `EROFS`/permission errors writing Claude session state | Claude Code is pointed at the read-only mount instead of the writable copy in `$HOME`. Fix the copy step or `$HOME`/`CLAUDE_CONFIG_DIR` for the worker.            |
| Works on one node, fails on another                    | Multi-node K3s: the image import and hostPath config only exist on some nodes. Import the image and provision the config on every node, or pin with node affinity. |
