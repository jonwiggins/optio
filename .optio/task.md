# Add pod scaling controls and worktree lifecycle management

Add pod scaling controls and worktree lifecycle management

## Description

Two related capabilities needed for production-grade pod-per-repo scaling:

### 1. Pod scaling controls

Users should be able to configure scaling limits for repo workspace pods:

- **Agents per pod**: Max number of concurrent agents (worktrees) in a single pod. Currently `repos.maxConcurrentTasks` controls this, but it conflates "how many tasks can run" with "how many can run in one pod."
- **Pod instances per repo**: Allow multiple pod replicas for the same repo (e.g., 3 pods for a high-traffic repo), with tasks load-balanced across them. Currently the system is strictly one-pod-per-repo.

This means the concurrency model changes from:

```
repo → 1 pod → N worktrees (capped by maxConcurrentTasks)
```

to:

```
repo → M pods (capped by maxPodInstances) → N worktrees each (capped by maxAgentsPerPod)
```

**Schema changes needed:**

- `repos` table: add `maxPodInstances` (default 1) and `maxAgentsPerPod` (default 2, replaces or supplements `maxConcurrentTasks`)
- `repo_pods` table: needs to support multiple rows per `repoUrl` (currently has a unique constraint on `repoUrl`)

**Task worker changes:**

- Pod selection: when a task arrives, pick the pod with the fewest active tasks (or create a new one if all are at capacity and under the instance limit)
- Idle cleanup: scale down to 1 pod when traffic drops, then to 0 after idle timeout

### 2. Worktree lifecycle management

When an agent halts (failure, crash, OOM, cancellation) the worktree it was using may be left in a dirty state. Currently `repo-cleanup-worker` cleans orphaned worktrees, but this is coarse — it deletes them entirely. We need more careful management:

- **Same-pod retry**: When a failed task is retried, it should be routed back to the same pod if possible, so it can reuse the existing worktree state (installed deps, build artifacts, etc.)
- **Worktree reset before reuse**: Before a retried agent starts in an existing worktree, reset it to a clean state: `git checkout -- . && git clean -fd` (or configurable reset strategy)
- **Worktree restore for resume**: When resuming a task (e.g., after review feedback), the worktree should still exist with the agent's prior work. Don't clean it up while the task is in `pr_opened` or `needs_attention` state.
- **Graceful cleanup**: Only fully remove a worktree when the task reaches a terminal state (`completed`, `cancelled`) AND is not eligible for retry

**Worktree states:**

```
active (agent running) → dirty (agent halted) → reset (cleaned for retry) → removed (terminal)
                                                                         ↘ preserved (pr_opened/needs_attention, keep for resume)
```

## Implementation notes

- The `repo_pods` unique constraint on `repoUrl` will need to be dropped or changed to allow multiple pods per repo
- Pod naming should incorporate an instance index (ties into #13)
- The `repoPool.getOrCreateRepoPod()` method needs to become a pod selector/scheduler
- Worktree cleanup logic in `repo-cleanup-worker.ts` needs to be state-aware
- Consider adding a `worktreeState` field to the `tasks` table or a new `worktrees` tracking table

## Acceptance criteria

- Users can configure max pod instances per repo and max agents per pod
- System creates additional pod replicas when demand exceeds single-pod capacity
- System scales down idle pod replicas
- Failed task retries prefer the same pod when possible
- Worktrees are reset (not deleted) before retry
- Worktrees are preserved for tasks in `pr_opened` or `needs_attention` state
- Worktrees are only fully removed on terminal states

---

_Optio Task ID: d45a3787-fb51-4a30-a393-7d9c233e0178_
