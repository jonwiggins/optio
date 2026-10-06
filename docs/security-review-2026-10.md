# Execution isolation and recovery review — October 2026

This is a focused code review and remediation of ownership, session sharing,
recovery and managed deployment configuration, not a penetration-test certification.

## Findings and changes

| Finding                                                                   | Impact                                                                                                   | Change                                                                                                                                                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo pools keyed only by repository URL                                   | Different users/workspaces could share readable processes, homes and files despite scoped secret lookup. | Pool selection, retry affinity, StatefulSet names, homes and caches now include workspace, owner, purpose and explicit access settings. Reviews have a separate purpose.           |
| Preferred pod accepted without matching pool/key                          | Retry affinity could bypass intended pool selection.                                                     | Validate pool, resource and isolation key before reuse; legacy null-key pods are excluded.                                                                                         |
| Deployment-wide Git credential signing key in pods                        | A pod could ask for another run's user credential.                                                       | Issue owner/workspace-derived keys from an API-only root; reject unscoped helper requests by default.                                                                              |
| Sharing a session in an owner's pooled pod                                | A link could expose unrelated work in the same pod.                                                      | New interactive sessions have dedicated pods. Legacy/non-dedicated pods cannot be shared.                                                                                          |
| Agent identity inherited API service account                              | A future token mount or shared IAM configuration could expose control-plane permissions.                 | Separate agent service account, no API RBAC, no automounted Kubernetes token.                                                                                                      |
| Startup/stale recovery killed agents, deleted worktrees and replayed work | Recoverable changes could be lost and external side effects repeated.                                    | Preserve work, retain durable turn receipts, require explicit action for uncertain outcomes, verify process-exit receipts and retain work through transient infrastructure errors. |
| Stateless terminal reconnect started another shell                        | Users could lose process context or control different shells in one session.                             | Reattach clients to the same tmux session; Local continues using the daemon's existing PTY.                                                                                        |
| Production examples suggested multiple API/web replicas                   | In-memory routing/broadcast/cancellation state could split across replicas.                              | Enforce one combined replica, Recreate upgrades, documented downtime and independent agent scaling.                                                                                |

## Boundaries that remain intentional

Organization-owned work shares its organization's credentials and execution pool
within a repository/access profile. Personal work can use the owner's credentials
plus permitted organization defaults. Work within one pool remains mutually
trusted; worktrees are not isolation. Explicit per-work access settings partition
pools, but rotating/removing a credential does not wipe copies from already-running
pods or revoke a credential at its provider. Retire those pods and revoke provider
credentials when changing trust, and inspect retained claims before reusing data.

Ordinary Kubernetes pods share the host kernel. Privileged images, host mounts,
broad node IAM roles or unrestricted networking can undermine isolation. This
change does not make a shared cluster suitable for hostile tenants by itself.
Use a dedicated environment or validated stronger sandbox where that is required.

Work ownership controls credential selection and execution placement; it is not a
new promise that every work log/metadata resource is private within an organization.
Session history and streams specifically require ownership or a valid sharing grant.
The user granting session control deliberately exposes its credentials, filesystem
and process capabilities. Local session collaborators inherit the machine user's
capabilities, beyond just the selected directory.

See [production deployment and recovery](production-eks.md) for migration handling,
Secret configuration, recovery states, retention and operational limitations.
