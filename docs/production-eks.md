# Production deployment on EKS

Optio currently runs **one combined API/web pod**. The API also runs the queue
workers, Local daemon relay, session chat broadcaster and cancellation registry.
The chart requires `api.replicas: 1`, disables API autoscaling and uses `Recreate`
for upgrades. This includes a brief control-plane outage; it is not an HA API.
Queue locks alone do not make the process-local relays safe across replicas.
Agent pods scale independently within each workspace, owner and access profile.

## Managed services and existing Secrets

Start with `helm/optio/values.production.yaml`. Set your public hostname, ingress
controller and TLS certificate. Use managed PostgreSQL and Redis, with encryption,
backups and credentials appropriate to your deployment. Redis must retain queue
state and must not evict queue keys. Enable TLS in the connection URLs according
to your managed service's requirements (`rediss://` for Redis).

Provision Kubernetes Secrets in the Optio namespace using your secret manager
(for example External Secrets Operator), then reference individual keys:

```yaml
postgresql:
  enabled: false
redis:
  enabled: false
existingSecrets:
  DATABASE_URL: { name: optio-runtime, key: database-url }
  REDIS_URL: { name: optio-runtime, key: redis-url }
  OPTIO_ENCRYPTION_KEY: { name: optio-runtime, key: encryption-key }
  GOOGLE_OAUTH_CLIENT_ID: { name: optio-sign-in, key: client-id }
  GOOGLE_OAUTH_CLIENT_SECRET: { name: optio-sign-in, key: client-secret }
  # Generic OIDC instead:
  # OIDC_ISSUER_URL: { name: optio-sign-in, key: issuer }
  # OIDC_CLIENT_ID: { name: optio-sign-in, key: client-id }
  # OIDC_CLIENT_SECRET: { name: optio-sign-in, key: client-secret }
```

`existingSecrets` maps environment variable names to `{name, key}` references on
**the API container**. It also supports GitHub/GitLab OAuth and other API settings.
Explicit Secret references override the chart's envFrom defaults. For database,
Redis, encryption and OAuth keys, their inline values are omitted from the
chart-generated Secret when a reference exists. Missing Secrets/keys prevent pod
startup. Secret values are never looked up by Helm or stored in Helm values.
Existing provider-specific `github.app.existingSecret`, APNs and FCM settings
continue to work. Restart the deployment after rotating an external Secret:
Kubernetes does not refresh existing environment variables in running containers.

Generate the encryption key once (`openssl rand -hex 32`) and back it up separately
from the database. **Keep the same key across upgrades and restores**: replacing
it makes saved credentials unreadable and invalidates pod credential-helper keys.
Changing a value in the secret manager is not an encryption-key migration.

## Storage, identity and network

Install/configure the EBS CSI driver and choose a StorageClass available in your
cluster; `gp3` below is an example, not a class the chart installs:

```yaml
agent:
  pvc:
    storageClass: gp3
    size: 10Gi
  cache:
    storageClass: gp3
  serviceAccount:
    create: true
    # name defaults to <release>-agent
    annotations: {}
```

StatefulSet repo pods have separate persistent claims for `/home/agent` and
`/workspace`, plus optional caches. Claims and pod names are partitioned by
workspace, owner, purpose and explicit work access settings. A sharable interactive
session gets its own pod. Budget storage/claim quotas for this increased isolation;
the production example quota is a starting point, not a capacity recommendation.
Retained claims are not automatically deleted on idle scale-down or recovery.
Back them up if unpushed work matters. Inventory and remove retained claims only
after confirming their work is no longer needed. Bare pods/pooled Jobs do not
provide the same workspace persistence as repo StatefulSets.

Agents use a separate service account, with no API-server RBAC and no automounted
Kubernetes token. Configure `agent.serviceAccount.annotations` for an intentionally
shared agent IAM role if required. Do not give it the API's permissions. An agent
IAM role is shared by agents using that account; per-owner cloud permissions
should use scoped Connections or a separately isolated deployment. Restrict node
instance metadata access and node roles accordingly.

Use a CNI that enforces NetworkPolicy; simply installing YAML does not enforce
network isolation. Review egress requirements for git providers, model APIs,
connections, DNS and the internal credential endpoint. Apply least-privilege
network and IAM policies for your environment. Containers share a kernel: pods
are useful process/filesystem boundaries, not a VM boundary against hostile tenants.
For mutually untrusted tenants, use separate clusters/accounts or an independently
validated sandbox runtime. See [Kubernetes multi-tenancy](https://kubernetes.io/docs/concepts/security/multi-tenancy/)
and [AWS tenant isolation guidance](https://docs.aws.amazon.com/eks/latest/best-practices/tenant-isolation.html).

## Upgrade and recovery behavior

Pin matching API, web and agent image versions. Back up PostgreSQL, encryption
keys and needed PVC data before the upgrade. Deploy the new agent images too:
recoverable pod terminals require `tmux`.

Old pods are deliberately **not relabeled** as isolated: their files may contain
credentials from several owners. New work uses new isolated pools. Existing
sessions retain their history and expose a legacy-pod recovery notice; a new
isolated session is required to create a collaboration link. Preserve/commit any
uncommitted work before ending old sessions. The old deployment-wide Git helper
key is rejected by default. `OPTIO_ALLOW_LEGACY_GIT_CREDENTIALS=1` re-enables the old
cross-owner credential capability and should not be used in a secure deployment.
Rotate credentials that may already have been exposed; isolation cannot retract
secrets previously read by a co-resident process.

The session recovery endpoint (`GET /api/session-recovery/{pod|local}/{id}`) and web
session banner distinguish live, reconnecting, resumable, lost and ended sessions:

| Interruption                           | Behavior                                                                                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser/network disconnect             | Reattach to the existing tmux shell or Local PTY; chat continues saving output. No input is automatically resent.                                                                                                                                       |
| API restart/upgrade                    | Local daemons reconnect with their existing PTYs. Chat receipts become interrupted. Pod Jobs and agents with uncertain execution stop for inspection; Repo Tasks preserve worktrees and become needs-attention/failed, or retain an already-created PR. |
| Worker/exec stream lost                | A missing process-exit receipt is an uncertain outcome, not successful completion. Uncertain Jobs do not auto-retry; persistent agents require explicit resume.                                                                                         |
| Repo StatefulSet pod loss              | Kubernetes can recreate the pod with retained home/workspace claims. Processes are lost; files survive if the volume survives. Review saved output before continuing.                                                                                   |
| Bare pod or machine process loss       | Recorded output remains. Resume an agent conversation only when its files still exist; otherwise start fresh deliberately.                                                                                                                              |
| Kubernetes API temporarily unavailable | Retain work and report reconnecting; a failed status request is not evidence the pod is gone.                                                                                                                                                           |

Chat requests carry durable UUID receipts: repeating an accepted request ID cannot
run the prompt again, even after API restart. Database claims and in-pod locks
prevent overlapping attempts. Incomplete repository setup is preserved for manual
inspection rather than silently repeated. This does **not** guarantee exactly-once
side effects in external systems. Explicit retries, external callbacks, agent
behavior and a failure between an external write and its acknowledgement still
require application-level idempotency or human inspection.

## Collaboration links

An owner can create a 24-hour collaboration link from a pod or Local session (API
expiry supports 1–168 hours). Recipients must sign in to the same active workspace
as a member/admin; viewers cannot control sessions. Redeeming a link grants access
to that session's terminal, chat and recorded output. The owner keeps lifecycle
and link-management controls. Tokens are random, stored only as hashes, and travel
in the URL fragment so normal HTTP access logs/referrers do not receive them.

Revocation closes current collaborators immediately; membership/expiry is checked
before input and periodically while streaming (up to 10 seconds). A collaborator
can read session credentials and run commands with the session owner's powers;
for Local this includes the machine account's capabilities. Revocation stops future
access, but cannot undo commands or erase secrets a collaborator already copied.
