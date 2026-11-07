# Fresh pod per run

By default a repo's work runs in the repo's shared pods: a pod is reused across runs (up to `maxAgentsPerPod` at once in each of `maxPodInstances` pods), each run in its own git worktree, and the pod stays until it has been idle for `OPTIO_REPO_POD_IDLE_MS`. That keeps starts fast, but a worktree is not a sandbox: whatever a run leaves outside its worktree (installed packages, files in the home directory, background processes, tool caches, credentials written to files) is there for the next run in that pod.

**Fresh pod per run** gives each run a pod made for it alone, removed as soon as the run ends. Every run starts from the image and the repo's setup, with nothing from earlier runs. The trade-off is a slower start: each run waits for a pod to be created and the repo to be cloned and set up.

It is off by default. With every repo and workspace on the default, behaviour is the same as before.

## Turning it on

- **A repo**: repo settings, **Pods**, **Pod per run**: _Workspace default_, _Shared pods_, or _Fresh pod per run_. API: `PATCH /api/repos/:id` with `podMode: "shared" | "per_run" | null` (null follows the workspace). Also a `Repo` manifest setting (`podMode`) in [config as code](config-as-code.md).
- **A workspace**: workspace settings, **Pods**: _Shared pods_, _Fresh pod per run_, or _Fresh pod per run, required_. API: `PATCH /api/workspaces/:id` with `podMode: "shared" | "per_run" | "per_run_required"` (workspace admins).

How the mode is decided (`services/pod-mode.ts`):

| Workspace          | Repo not set | Repo `shared` | Repo `per_run` |
| ------------------ | ------------ | ------------- | -------------- |
| `shared` (default) | shared       | shared        | fresh pod      |
| `per_run`          | fresh pod    | shared        | fresh pod      |
| `per_run_required` | fresh pod    | fresh pod     | fresh pod      |

Under `per_run_required`, setting a repo to `shared` is refused (`400` from the API, an error from a config apply) and any older `shared` value is ignored. `GET /api/repos/:id` reports `workspacePodMode` and `effectivePodMode` next to the repo's own `podMode`.

## What runs in a fresh pod

| Work                                    | Fresh pod per run | Notes                                                             |
| --------------------------------------- | ----------------- | ----------------------------------------------------------------- |
| Repo tasks (including review subtasks)  | yes               | One pod per run attempt; a retry or a resume gets a new one.      |
| PR reviews and review chat              | yes               |                                                                   |
| Terminal sessions on a repo             | yes               | The session is the run: its pod is removed when the session ends. |
| Jobs, agent sessions, persistent agents | no                | They don't use repo pods; their own pools and settings apply.     |

## How it works

- **Never reused.** A fresh pod's isolation key includes an id for its run (`podIsolationKey` with `runId`), so no other run can ever pick it, including a retry that asks for the pod its last attempt used. Shared pods keep exactly the keys they had.
- **Nothing persistent.** A fresh pod is always a bare pod (also when StatefulSets are enabled), with no persistent home volume and none of the repo's shared cache directories mounted. Its home directory goes with the pod.
- **Removed when the run ends.** Whether the run finished, failed or was cancelled, the pod is deleted when the run gives back its slot (`releaseRepoPodTask`). A run that got a pod but never started its agent there (it failed or was cancelled first, or found its PR already open) removes it too (`discardUnusedRunPod`). If a removal fails, or the instance finishing a run went away, the repo cleanup sweep (`cleanupPerRunRepoPods`) removes it on a later pass.
- **Kept for recovery, for a while.** Like shared pods, a pod is kept when a run on it needs recovery or its workspace was preserved after an interrupted run (the run stopped reporting, or its instance died). A fresh pod is kept like that for at most `OPTIO_PER_RUN_POD_RECOVERY_MS` (default 24 hours) after its last change, then removed.
- **Instance limit.** `maxPodInstances` caps how many fresh pods exist at once for the same isolation boundary (what shared pods would have been shared under). Each fresh pod holds one run, so a repo runs at most `maxPodInstances` tasks at a time and `maxAgentsPerPod` is not used. At the limit a run waits up to `OPTIO_PER_RUN_POD_WAIT_MS` (default 2 minutes) for one to free up, then fails provisioning and is retried like any other provisioning failure. Pods kept for recovery don't count against the limit.

## Resuming work

The agent session a resume would continue lived in the pod that was removed. So in a fresh pod:

- **Task resumes and follow-ups** (a manual resume, a chat message, an automatic resume on CI failure or review feedback) start a new agent session in a new pod, with the resume prompt first and the original task prompt for context. A resume that would have continued a session checks the worktree out from the task's pushed branch when there is one; an automatic resume on a task with a PR does so already.
- **Review chat** starts a new session that is given the review's verdict, summary and inline comments before the question.

## Settings

| Variable                        | Default    | Meaning                                                                                                                               |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `OPTIO_PER_RUN_POD_WAIT_MS`     | `120000`   | How long a run waits for a free fresh pod at the instance limit.                                                                      |
| `OPTIO_PER_RUN_POD_GRACE_MS`    | `120000`   | A fresh pod no live run references yet (just made) or any more (its removal failed) counts as in use this long after its last change. |
| `OPTIO_PER_RUN_POD_RECOVERY_MS` | `86400000` | How long a fresh pod kept for recovery stays.                                                                                         |
