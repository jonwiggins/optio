# Agent policy

Optio starts agents with their permission checks skipped
(`--dangerously-skip-permissions`), so they can work without anyone
answering prompts. They also read text anyone may write: merge request
descriptions, review comments, tickets. An agent policy is the list of things
an agent may not do whatever the repo or the prompt asks, plus where its pod
may connect and the sandbox it runs in.

It has three parts:

| Part         | What it does                                                                                                                           | Who sets it                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Deny rules   | Claude Code permission rules (`Read(**/.env*)`, `Bash(git push --force *)`) every agent run gets; OpenCode gets the same in its syntax | Workspace admins, team admins for their team, workspace admins per repo          |
| Egress       | The hosts and addresses agent pods may connect to, beyond DNS and Optio                                                                | The operator, in the chart ([Egress allowlist](#egress-allowlist))               |
| RuntimeClass | A sandbox between the agent and the node (gVisor, Kata)                                                                                | The operator for every pod; a workspace admin per repo, from the operator's list |

## Where to find it

- **Workspace settings → Agent policy**: the built-in rules (on or off), the
  workspace's own rules, where agent pods may connect, and the
  RuntimeClasses. Everyone in the workspace can read it; workspace admins
  change it.
- **Teams → a team → Agent policy**: the rules the team's work adds. The
  team's admins and workspace admins change them; its members read them.
- **Repos → a repo → Agent policy**: the rules work in that repo adds, and
  the repo's RuntimeClass. Workspace admins change them (a repo's settings
  are an admin's).
- **The run page** (a Task's details): the rules the run started with, where
  each came from, and how they reached the agent.

Every change is in the audit trail as `agent_policy.update`, with the level,
the rules added and removed, and the switches changed
([audit.md](audit.md)).

## The deny rules

A run gets, in this order, each rule once:

1. the **built-in rules**, unless the workspace turned them off;
2. the **workspace's** rules;
3. the rules of the **team** that owns the work (none for a person's own or
   the organization's work);
4. the rules of the **repo** the work runs in.

A team or a repo only adds rules; it can't take away the workspace's.

### The built-in rules

Off by default, so Optio behaves as upstream until someone turns them on:
the deployment with `OPTIO_AGENT_POLICY_DEFAULTS=true` (Helm
`agentPolicy.builtInRules: true`), or a workspace admin under Workspace
settings → Agent policy, which picks **Deployment default**, **On** or
**Off**.

| Rule                                                                                                                                                         | Why                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `Read(**/.env*)`, `Read(**/*.pem)`, `Read(**/*.key)`                                                                                                         | Secrets and keys checked into, or left in, the repo                                                                   |
| `Read(~/.git-credentials)`, `Read(~/.ssh/**)`                                                                                                                | Credentials in the agent's home                                                                                       |
| `Edit(//etc/claude-code/**)`                                                                                                                                 | The file that holds these rules                                                                                       |
| `Bash(git push --force)`, `Bash(git push --force *)`, `Bash(git push -f*)`, `Bash(git push * --force)`, `Bash(git push * --force *)`, `Bash(git push * -f*)` | Rewriting published history. `--force-with-lease` is allowed: Optio's own prompts use it to push a rebased run branch |
| `Bash(curl * \| sh*)`, `Bash(curl * \| bash*)`, `Bash(wget * \| sh*)`, `Bash(wget * \| bash*)`                                                               | Running a script straight from a download                                                                             |
| `Bash(rm -rf /)`, `Bash(rm -rf ~)`                                                                                                                           | Wiping the pod                                                                                                        |

### Writing rules

One rule per line, in Claude Code's permission syntax: a tool, then what it
applies to in brackets.

| Rule                           | Denies                                                           |
| ------------------------------ | ---------------------------------------------------------------- |
| `Read(**/secrets/**)`          | Reading any file under a `secrets` directory, at any depth       |
| `Read(//etc/shadow)`           | One absolute path (`//` starts an absolute path)                 |
| `Read(~/.aws/**)`              | A path in the agent's home                                       |
| `Edit(**/.gitlab-ci.yml)`      | Changing the pipeline (Edit covers every tool that writes files) |
| `Bash(terraform apply*)`       | A command, by its start (`*` matches anything)                   |
| `WebFetch(domain:example.com)` | Fetching from a domain (Claude Code only)                        |
| `Bash`                         | The whole tool                                                   |

A rule that isn't one (`Read(` or `Bash()`) is refused with what's wrong.
Each level holds at most 100 rules of at most 300 characters.

### How they reach the agent

- **Claude Code** gets them in `/etc/claude-code/managed-settings.json`
  (`permissions.deny`), its _managed_ settings tier. A repo's own
  `.claude/settings.json` can't override that tier, and Claude Code applies
  deny rules in every permission mode, including the skipped checks Optio
  starts agents with. A repo pod made before the upgrade to this release
  (an older agent image, still warm) has no `/etc/claude-code` the agent may
  write: that run gets the rules in the agent's own `~/.claude/settings.json`
  instead, which hold in every mode too, and the log says so ("this pod
  predates the agent policy"). The pods made after the upgrade use the
  managed tier.
- **OpenCode** gets the `Read`, `Edit`, `Write` and `Bash` rules in its
  `permission` config, added after Optio's headless rules (no questions, no
  `sudo` / `apt`, nothing outside the working directory). The pod adds them
  to `OPENCODE_CONFIG_CONTENT`, the inline config OpenCode reads after the
  repo's own `opencode.json`, so the repo can't loosen them. When the work
  brings its own `OPENCODE_CONFIG_CONTENT` (a pod secret with the provider
  for a model at a private endpoint, for example), the rules are merged into
  it: its provider, model and other settings stay, its own `permission`
  entries stay, and the policy's deny entries come after them, so they win.
  A value that isn't plain JSON (comments, trailing commas) stops the run
  with a message saying so, rather than starting OpenCode without its rules.
  Rules for other tools (`WebFetch`, MCP tools) are Claude Code only; the run
  page lists them under "has no equivalent".
- **Other runtimes** get none; the run page says so.
- **Remote workspaces** get both files read-only: a Coder workspace from
  the template's `optio_claude_managed_settings` and
  `optio_opencode_managed_config` parameters, a Daytona, E2B or GitHub
  Codespaces workspace from the start script's environment
  ([remote-workspaces.md](remote-workspaces.md#how-it-fits)).

Every pod run gets them: Tasks, code reviews, Job runs, persistent agents'
turns and interactive sessions. The Ask Optio assistant doesn't (it works
with Optio's own tools, not a repo), nor does a Job that runs a command
instead of an agent.

### Runs that share a pod

A repo pod serves several Tasks, and a Job's pod serves its runs, so Claude
Code's managed settings are one file per pod. Optio keeps that file right
for the run starting:

- Runs share a pod only with work of the same workspace, owner, settings and
  pod secrets. A team's Tasks get pods of their own, apart from their
  creator's personal Tasks and other teams', so a team's rules are never
  overwritten by work without them.
- A Claude Code run that has no rules (the built-in rules turned off and
  nothing else set) removes the file an earlier run left in the pod, so old
  rules don't outlive the policy.
- A change to the policy reaches a pod when its next run starts. Whether an
  agent already working there picks up the new file depends on Claude Code
  re-reading its settings; don't count on either.

### What they don't do

Deny rules stop the agent's own tools. They are pattern matches, not a
sandbox: a `Read` rule doesn't stop `cat .env` in a shell, and a `Bash` rule
matches the command's text, so a command written another way gets past it.
They make the easy path the safe one and stop a prompt injection that uses
the obvious tools. What keeps data in is the egress allowlist below, and
what keeps the node safe is the RuntimeClass.

In an agent pod the file is written by the same user the agent runs as, so a
determined shell command could rewrite it (the `Edit` rule only stops
Claude Code's own editing tools). In a remote workspace the files are
read-only (a Coder template mounts them; the start script writes them as
root).

## Where agent pods may connect

Shown under Workspace settings → Agent policy, set by the operator in the
chart:

- **Not enforced**: the chart's NetworkPolicy is off; agent pods connect
  wherever the cluster lets them.
- **Any host on 443 and 80**: upstream's rule. Agent pods reach DNS, the
  Optio API and any address on ports 443 and 80 (an in-cluster service
  listening there included).
- **Allowlist**: DNS, the Optio API and only the listed addresses: the deployment's
  GitLab, the model gateway, the package mirrors. A prompt-injected `curl`
  to anywhere else times out.

## RuntimeClass

A Kubernetes RuntimeClass runs the pod under another container runtime:
gVisor (`runsc`) intercepts the agent's system calls in user space, Kata
Containers runs each pod in a small virtual machine. The operator sets one
for every agent pod and lists the classes the cluster has; a workspace admin
can pick another of those for a repo (Repos → the repo → Agent policy). A
class the deployment doesn't list is refused when it is picked, and a repo
whose class the deployment later drops fails its next pod at once, naming
the classes there are.

Docker-in-Docker (the `dind` image preset) can't run under gVisor.

The run page shows the class the run's policy named when it started. A pod
keeps the class it was made with: repo pods idle out after 10 minutes, and
the next one gets a changed class.

## For developers

The policy model and its resolution are pure functions in
`packages/shared/src/agent-policy.ts` (`resolveAgentPolicy`,
`claudeManagedSettings`, `opencodeDenyPermission`). The API side is
`apps/api/src/services/agent-policy.ts` (storage, `applyAgentPolicy`,
`repoRuntimeClass`, `coderPolicyParameters`, the egress view) and
`apps/api/src/routes/agent-policy.ts`. The pod's part (the OpenCode merge,
removing an earlier run's Claude Code file) is
`apps/api/src/utils/agent-policy-pod.ts`, run by every exec script at the
end of `WRITE_SETUP_FILES` (pod-env.ts). Upstream files carry one call or
field each: `buildAgentEnvironment` (agent-environment-service.ts),
`agentNodePlacement` (agent-node-placement.ts), the repo pod specs and the
restricted per-pod NetworkPolicy (repo-pool-service.ts), the team in the
repo pod's isolation key (pod-isolation.ts, task-worker.ts),
`startCoderWork` (coder-service.ts). The database: `workspaces.agent_policy`,
`teams.agent_policy`, `repos.agent_policy` (jsonb, null = nothing set) and
`run_agent_policies` (what each run got), in
`1792780000_agent_policy.sql`.

## Operator deployment examples

## Egress allowlist

```yaml
networkPolicy:
  enabled: true
  agentEgress:
    - name: GitLab
      cidr: 10.20.0.15/32
      ports: [443, 22]
    - name: The deployment's ingress (the model gateway, the package mirror)
      namespace: ingress-nginx
      podLabels: { app.kubernetes.io/name: ingress-nginx }
      ports: [443]
    - name: Package mirror network
      cidrs: [10.30.0.0/24]
      except: [10.30.0.1/32]
```

- **Empty** (the default): the chart renders upstream's NetworkPolicy
  unchanged. Repo pods reach DNS, the Optio API and any address on ports 443
  and 80. Job pods and persistent agents' pods are not selected by it.
- **Not empty**: one NetworkPolicy selects **every agent pod** (repo pods,
  Job pods, persistent agents' pods: `optio.type` in `repo-pod`,
  `workflow-pod`, `persistent-agent-pod`) and lets them reach DNS, the Optio
  API and these entries only. Ingress stays denied.

Each entry has a `name` (shown under Workspace settings → Agent policy), at
least one destination (`cidr`, `cidrs`, or a `namespace` with optional
`podLabels`; `except` narrows `cidr` / `cidrs`) and `ports` (TCP, default
`[443]`). An entry with no destination fails the render: an empty `to` would
allow every destination.

NetworkPolicy takes addresses and pods, not host names. For a service behind
the deployment's ingress controller, allow the controller (its pods by namespace
and labels, or its address); for one outside the cluster, its address or
network. Then every host on that ingress is reachable, which is usually
what you want for the gateway and the mirrors.

The cluster's network plugin must enforce NetworkPolicy (Calico, Cilium,
Canal on RKE2). Without one the policy is accepted and ignored.

A repo set to restricted egress (`networkPolicy: restricted` on the repo,
upstream's per-pod policy) adds DNS only while the allowlist is on: its own
"443 anywhere" and "the whole namespace" rules would widen the allowlist
again, since policies add up.

The API gets the list as `OPTIO_AGENT_EGRESS` (JSON) to show it in Settings;
the NetworkPolicy itself is the chart's.

### Check it

```bash
kubectl -n <namespace> get networkpolicy <release>-repo-pod-policy -o yaml
# From an agent pod: the gateway answers, an address outside the list times out.
kubectl -n <namespace> exec <agent pod> -- curl -sS -m 5 -o /dev/null -w '%{http_code}\n' https://<gateway>/health/liveliness
kubectl -n <namespace> exec <agent pod> -- curl -sS -m 5 https://<some in-cluster service>   # times out
```

Only a timeout shows the policy at work: the NetworkPolicy drops the packets.
"Could not resolve host" or "Connection refused" say nothing about it (a
wrong name, or nothing listening there), so check against a service you know
is up.

## RuntimeClass

```yaml
agent:
  runtimeClassName: gvisor # every agent pod; empty = the cluster's default runtime
  runtimeClasses: [gvisor, kata] # the classes a repo may pick over it
```

- `runtimeClassName` goes on every agent pod Optio makes: repo pods
  (StatefulSets and bare pods), Job pods and persistent agents' pods
  (`OPTIO_AGENT_RUNTIME_CLASS`).
- `runtimeClasses` lists the classes the cluster has
  (`OPTIO_AGENT_RUNTIME_CLASSES`). Optio's account is namespaced (unless
  `rbac.clusterRole.create`) and can't list a cluster's RuntimeClasses, so
  the chart says which there are, as
  `agent.presets` does for image presets. A repo may pick one of these, or
  the deployment's own, under Repos → the repo → Agent policy; any other is
  refused. A repo whose class you later drop from the list fails its next
  pod at once, naming the classes there are.
- The class must exist before a pod asks for it (`kubectl get runtimeclass`);
  a pod naming a missing class is rejected by Kubernetes.

On RKE2, gVisor and Kata are installed on the nodes (containerd runtime
handlers `runsc` / `kata`) and a `RuntimeClass` object names each:

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
```

Docker-in-Docker (the `dind` preset) can't run under gVisor: give such a
repo the cluster's default runtime, or Kata.

## Remote workspaces

Daytona, E2B and GitHub Codespaces workspaces get the policy in the start
script's environment (`OPTIO_CLAUDE_MANAGED_SETTINGS`,
`OPTIO_OPENCODE_MANAGED_CONFIG`), which writes it as root or with `sudo -n`
and doesn't start the daemon when it can't
([remote-workspaces.md](remote-workspaces.md#the-start-script)).

The example Coder template (`examples/coder/optio-workspace`) takes the policy as
two parameters Optio fills, `optio_claude_managed_settings` and
`optio_opencode_managed_config`, and mounts them read-only at
`/etc/claude-code/managed-settings.json` and `/etc/opencode/opencode.json`
from a ConfigMap (the workspaces' service account needs `configmaps`, as for
the CA). A template without the parameters gets nothing. A workspace that is
already running when work starts there keeps the policy of its last build.
