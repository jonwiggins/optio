# Pod scope: a pod per repo, or a pod per run

By default a repository's runs share its pod. The pod clones the repo once and
stays up; each task or PR review gets a git worktree in it, and the pod goes
away after it has been idle (`OPTIO_REPO_POD_IDLE_MS`, 10 minutes). Whether a
new run starts a new pod therefore depends on what else is running: a second
task of the same owner, purpose and access settings lands in the pod that is
already there.

**Pod scope `run`** changes that: every task and every PR review gets a pod of
its own, with its own fresh clone, that no other run uses.

| Scope            | Pods                                        | Start   | Between runs                                                         |
| ---------------- | ------------------------------------------- | ------- | -------------------------------------------------------------------- |
| `repo` (default) | One per repo and execution boundary, reused | Fast    | Clone, home directory and shared cache directories are kept          |
| `run`            | One per task / PR review                    | A clone | Nothing is kept: the pod and its volumes are removed once it is idle |

## Choosing it

The repo's own setting wins; without one the deployment's default applies.

- **One repo**: repo settings → **Pods** → **Pod scaling** → _Pods are shared
  by_ (`Deployment default` / `The repo` / `Nothing: a pod per run`). Over the
  API: `PATCH /api/repos/:id` with `{ "podScope": "run" }` (`"repo"`, or `null`
  to follow the deployment). In the database: `repos.pod_scope`.
- **Config as code**: `podScope: run` in a `Repo` manifest's `spec`.
- **The whole deployment**: Helm `agent.podScope: run`, which sets
  `OPTIO_POD_SCOPE=run` on the API. A repo set to `repo` still shares its pod.

A change applies to the next run; pods that are already up finish their runs
and are cleaned up when idle as before.

## What a run's own pod is

- The run's pod is found again by the same run: a retry, a resume after review
  feedback or a CI failure, and a restart all return to it while it is still
  up, with the worktree as the agent left it. After the idle window the pod is
  gone and the next attempt starts from a fresh clone and the pushed branch, as
  it does today when a shared pod has been reaped.
- A task's code review is a run of its own, in its own pod.
- Nothing outlives the pod. On bare pods the home directory is the pod's
  ephemeral storage; with StatefulSets the home and workspace volumes are
  deleted with the StatefulSet (`persistentVolumeClaimRetentionPolicy`, on by
  default from Kubernetes 1.27). Shared cache directories are not mounted: a
  cache volume made for one run would never be read again.
- Limits keep their meaning. `maxPodInstances × maxAgentsPerPod` (and
  `maxConcurrentTasks`, `OPTIO_MAX_CONCURRENT`) is how many of the repo's runs
  are in flight at once, which under this scope is also how many pods it has.
- Resources, image, network policy and Docker-in-Docker are the repo's, as for
  a shared pod.

Interactive sessions always had a pod of their own and are unaffected. Jobs
(their pods are per Job, not per repo) and persistent agents (one pod per
agent) are not covered by this setting.

Code: `services/pod-isolation.ts` (`resolvePodScope`, the `runId` part of the
pod's isolation key), `services/repo-pool-service.ts`.
