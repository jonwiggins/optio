# Agent policy

Optio starts Claude Code with its permission checks skipped
(`--dangerously-skip-permissions`) so it can work without anyone answering
prompts, and agents read text anyone may write: issue and pull request
descriptions, review comments, tickets. Agent policy adds three controls on
top of that. Each is off by default; with all three off, agent pods and runs
are exactly what they were before.

| Control      | What it does                                                         | Who sets it                                                     |
| ------------ | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| Deny rules   | Claude Code permission rules every agent run gets (OpenCode in part) | The operator (built-in list, every workspace); workspace admins |
| Egress       | The only destinations agent pods may connect to                      | The operator, in the chart                                      |
| RuntimeClass | A sandbox between the agent and the node (gVisor, Kata)              | The operator, in the chart                                      |

## Deny rules

A run gets, in this order and each rule once:

1. the **built-in rules**, when the operator turned them on for the
   deployment (Helm `agentPolicy.builtInRules: true`,
   `OPTIO_AGENT_POLICY_DEFAULTS=true`) or a workspace admin turned them on
   for the workspace;
2. the **workspace's** rules (Workspace settings → Agent policy);
3. the rules of the **repo** the work runs in (Repos → the repo → Agent
   policy).

A level only adds rules. A workspace admin can't turn the built-in rules off
when the operator turned them on, and a repo can't remove a workspace rule.

Who may change what:

- the deployment's switch is a chart value: nobody changes it from the app;
- a workspace's rules and its repos' rules: that workspace's admins. Other
  members read them. A repo of another workspace is not found (404), for
  reading and for writing.

Every change is in the action log as `agent_policy.update`, with the rules
added and removed.

### The built-in rules

| Rule                                                                                                                                                         | Why                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `Read(**/.env*)`, `Read(**/*.pem)`, `Read(**/*.key)`                                                                                                         | Secrets and keys in the checkout                                                 |
| `Read(~/.git-credentials)`, `Read(~/.ssh/**)`                                                                                                                | Credentials in the agent's home                                                  |
| `Edit(//etc/claude-code/**)`                                                                                                                                 | The file that holds these rules                                                  |
| `Bash(git push --force)`, `Bash(git push --force *)`, `Bash(git push -f*)`, `Bash(git push * --force)`, `Bash(git push * --force *)`, `Bash(git push * -f*)` | Rewriting published history (`--force-with-lease`, which Optio uses, is allowed) |
| `Bash(curl * \| sh*)`, `Bash(curl * \| bash*)`, `Bash(wget * \| sh*)`, `Bash(wget * \| bash*)`                                                               | Running a script straight from a download                                        |
| `Bash(rm -rf /)`, `Bash(rm -rf ~)`                                                                                                                           | Wiping the pod                                                                   |

### Writing rules

One rule per line, in Claude Code's permission syntax: a tool, then what it
applies to in brackets. At most 100 rules per level, 300 characters each; a
rule that isn't one (`Read(`, `Bash()`) is refused with the reason.

| Rule                           | Denies                                    |
| ------------------------------ | ----------------------------------------- |
| `Read(**/secrets/**)`          | Any file under a `secrets` directory      |
| `Read(//etc/shadow)`           | One absolute path (`//` starts one)       |
| `Edit(**/.gitlab-ci.yml)`      | Changing the pipeline                     |
| `Bash(terraform apply*)`       | A command, by how it starts               |
| `WebFetch(domain:example.com)` | Fetching from a domain (Claude Code only) |
| `Bash`                         | The whole tool                            |

### How they reach the agent

- **Claude Code** gets them in `/etc/claude-code/managed-settings.json`
  (`permissions.deny`), its managed settings. A repo's own
  `.claude/settings.json` can't override them, and deny rules hold in every
  permission mode, including the skipped checks Optio starts agents with.
- **OpenCode** gets the `Read`, `Edit`, `Write` and `Bash` rules as
  `permission` entries in `OPENCODE_CONFIG_CONTENT`, the inline config it
  reads after the repo's own `opencode.json`. Other rules (`WebFetch`, MCP
  tools) have no OpenCode equivalent; the settings page marks them "Claude
  Code only".
- **Other runtimes** get none. The run's log line "Applying the agent
  policy" lists the rules a runtime didn't get.

Every agent run that starts in a pod gets them: Tasks, reviews, Job runs,
persistent agents' turns and interactive sessions. The Ask Optio assistant
doesn't (it uses Optio's own tools), nor does a Job that runs a command
instead of an agent.

If Optio can't read the policy (the database is unreachable), the run does
not start. If the pod's image has no `/etc/claude-code` the agent user can
write, the run stops with "Agent image can't take the agent policy" instead
of starting without its rules. The agent images from this release create
that directory; a custom image needs
`RUN mkdir -p /etc/claude-code && chown agent:agent /etc/claude-code`.

Repo and Job pods serve several runs. Once any rule was ever set for a
workspace or repo (or the deployment switch was set at all), every Claude
Code run there writes the file, an empty list included, so the rules of an
earlier run never outlive a change. With nothing ever set, nothing is
written.

### What they don't guarantee

Deny rules stop the agent's own tools. They are pattern matches, not a
sandbox:

- a `Read` rule doesn't stop `cat .env` in a shell, and a `Bash` rule matches
  the command's text, so the same command written another way gets past it;
- the managed settings file is written by the agent's own user, so a shell
  command could rewrite or delete it for the rest of that pod's life (the
  `Edit` rule only stops Claude Code's editing tools). The next run rewrites
  it;
- for OpenCode, a repo's own `opencode.json` is merged under the inline
  config by OpenCode itself; a repo file that repeats a rule's exact pattern
  and adds a broader allow after it can win.

They make the easy path the safe one and stop a prompt injection that uses
the obvious tools. What keeps data in is the egress allowlist; what keeps the
node safe is the RuntimeClass.

## Egress allowlist

```yaml
networkPolicy:
  enabled: true
  agentEgress:
    - name: GitLab
      cidr: 10.20.0.15/32
      ports: [443, 22]
    - name: Ingress controller (model gateway, package mirror)
      namespace: ingress-nginx
      podLabels: { app.kubernetes.io/name: ingress-nginx }
      ports: [443]
    - name: Package mirror network
      cidrs: [10.30.0.0/24]
      except: [10.30.0.1/32]
```

- **Empty** (the default): the chart's NetworkPolicy is rendered exactly as
  before: agent pods reach DNS, the Optio API and public addresses on 443
  and 80.
- **Not empty**: the public 443/80 rule is replaced by these entries. Agent
  pods (every pod labelled `managed-by: optio`) reach DNS, the Optio API,
  `networkPolicy.extraEgress` and these destinations only.

Each entry has a `name`, at least one destination (`cidr`, `cidrs`, or a
`namespace` with optional `podLabels`; `except` narrows `cidr`/`cidrs`) and
`ports` (TCP, default `[443]`). The chart refuses to render an entry with no
destination, a CIDR that isn't one or is a `/0`, a port outside 1-65535, an
unknown key (a `host:` for example) and an allowlist without
`networkPolicy.enabled`.

NetworkPolicy takes addresses and pods, not host names. For a service behind
the ingress controller, allow the controller's pods; for one outside the
cluster, its address or network.

**The cluster's network plugin must enforce NetworkPolicy** (Calico, Cilium,
Canal). Without one the policy is accepted and does nothing.

A repo set to restricted egress (its own per-pod NetworkPolicy) adds DNS and
the API only while the allowlist is on: policies add up, and its usual public
HTTPS rule would reopen what the allowlist closed. The API gets the list as
`OPTIO_AGENT_EGRESS` to show it under Workspace settings → Agent policy and
for that decision; a value it can't read counts as an allowlist, so it never
widens anything.

Check it from an agent pod: the allowed destination answers, anything else
times out (`curl -m 5`). "Could not resolve host" or "Connection refused" say
nothing about the policy.

## RuntimeClass

```yaml
agent:
  runtimeClassName: gvisor # empty = the cluster's default runtime
```

The class goes on every agent pod Optio makes: repo pods, Job pods and
persistent agents' pods (`OPTIO_AGENT_RUNTIME_CLASS`). The chart and the API
both check the name (a DNS subdomain); an invalid one fails the render, and
in the API it stops pods from being created rather than starting them
without the sandbox. The class must exist in the cluster
(`kubectl get runtimeclass`); Kubernetes rejects a pod that names a missing
one. A pod keeps the class it was created with; repo pods pick up a change
when they are replaced.

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
```

Docker-in-Docker (the `dind` image preset) can't run under gVisor.

## For developers

The rules and their resolution are pure functions in
`packages/shared/src/agent-policy.ts`. The API side is
`apps/api/src/services/agent-policy.ts` (storage, `applyAgentPolicy`, called
once from `buildAgentEnvironment`), `apps/api/src/utils/agent-policy-env.ts`
(the chart's values) and `apps/api/src/routes/agent-policy.ts`. Rules are
stored in `agent_policies` (one row per workspace, one per repo;
`1794726000_agent_policy.sql`).
