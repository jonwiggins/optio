# Config as code: manifests, sources, and the CLI

Teams that run their infrastructure from a repository want Optio to work the
same way: the Jobs, scheduled Tasks, agents, prompts, repos, MCP servers and
skills a workspace runs are files in a directory, reviewed in pull requests,
and a cluster loads them by itself. Today every one of those lives only in the
database, is created by hand in the UI, and has no export.

This plan adds **manifests** (one YAML document per resource), **config
sources** (where a cluster reads them from), an **apply** that makes the
workspace match the files, and the CLI and UI around them.

**Status (2026-10-04):** implemented — see [config-as-code.md](../config-as-code.md)
for the shipped behavior; this document keeps the reasoning and the decisions.

## Vocabulary

| Word              | Meaning                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Manifest**      | One YAML document describing one resource: `apiVersion: optio/v1`, `kind`, `metadata.name`, `spec`. A file may hold several, separated by `---`.        |
| **Config source** | Where a workspace's manifests come from: in this version a **directory** in the API pod, mounted by the chart.                                          |
| **Managed**       | A resource a source created or adopted. It shows **Managed by _source_ · _path_**; the file is the truth and the UI is read-only for it.                |
| **Apply**         | Make the resources match a set of manifests: create, update, leave unchanged, prune what the source no longer declares, and report errors per manifest. |
| **Detach**        | Stop managing a resource (admin). It stays, as an ordinary one you edit in the UI.                                                                      |

## Starting point (verified in code)

- `WorkSpec` (`packages/shared/src/work/spec.ts`), the body of `POST /api/work`,
  already describes every kind of work by its five attributes, and the server
  derives the kind. It is the right skeleton for a `Work` manifest.
- Identity is uneven. Work definitions are unique on (kind, workspace, name),
  persistent agents on (workspace, slug), prompts on (workspace, owner, name),
  repos on (url, workspace). **MCP servers, skills and connections have no
  unique name**; the apply has to enforce one for what it manages.
- `WorkSettings` names connections, MCP servers and skills by **UUID**, which
  means nothing in another cluster. Manifests name them by **name**; the apply
  resolves names in the workspace.
- `PATCH /api/work/:id` only saves `work_definitions`: a persistent agent can't
  be saved from a spec today (`getOwnDefinition`). The apply needs that path.
- Some definition columns aren't in `WorkSpec` (`enabled`, `maxTurns`,
  `budgetUsd`, `maxPodInstances`, `maxAgentsPerPod`, `paramsSchema`). An export
  that dropped them would lose configuration, so the manifest carries them.
- The API container's root filesystem is read-only: `/tmp` and the skills
  cache are the writable paths, so a mounted configuration directory is read,
  never written.
- The chart has no `extraVolumes` / ConfigMap hooks; the only pattern to copy
  is the installed-skills cache PVC.
- The CLI is commander-based with a JSON `ApiClient` (`get/post/patch/delete`),
  stores its PAT and workspace id in `~/.config/optio/`, and has no `export` /
  `apply`. No package depends on a YAML library yet (`yaml` 2.9 is a pnpm override).
- No resource has a "managed by" notion. `agent_pods.managed_by` exists and
  means something else; the name is avoided.

## The manifest format

```yaml
# yaml-language-server: $schema=https://optio.example.com/api/config/schema.json
apiVersion: optio/v1
kind: Work
metadata:
  name: nightly-dependency-bump # the identity: unique per workspace and kind
  description: Bumps dependencies every weeknight and opens a PR
spec:
  when:
    schedule: "0 3 * * 1-5" # or webhook / ticket / github / slack / linear; absent = on demand
  where:
    repo: https://github.com/acme/api
    branch: main
  who:
    runtime: claude-code
    options: { model: claude-sonnet-4-5, effort: high }
  what:
    promptFile: ./prompts/dependency-bump.md # or prompt: | ...
    runTitle: "Dependency bump {{date}}"
  then: until-merged # exits | until-merged | waits-for-messages
  mergeWhenReady: true
  retries: 3
  priority: 100
  secrets: [GITHUB_TOKEN, NPM_TOKEN] # pod secrets, by name — never values
  environment: # WorkSettings, by name
    connections: { add: [Linear] }
    mcpServers: { add: [internal-docs] }
    skills: { add: [release-notes] }
    setupCommands: pnpm install
    review: { enabled: true, trigger: on_pr }
    cautiousMode: true
    maxAutoResumes: 3
  params: { ... } # paramsSchema for triggered work
  limits: { maxTurns: 40, budgetUsd: "5" }
  pods: { maxPodInstances: 1, maxAgentsPerPod: 2 }
  enabled: true
```

Rules:

- **`when`** has one key, the trigger type, holding that trigger's config in the
  shape the API stores (`schedule` takes the cron string as a shorthand; `webhook`
  takes `{ path }`; `github` / `slack` / `linear` / `ticket` take their config
  objects). A webhook's signing secret is not in the file; it is set once through
  the trigger API and kept across applies (as `updateWork` keeps it today).
- **`then: waits-for-messages`** makes a persistent agent, with
  `agent: { slug, systemPrompt | systemPromptFile, agentsMd | agentsMdFile, podLifecycle }`.
- **Kinds a manifest can't be**: a one-off Task (`then: exits` with a repo and
  no trigger — a run, not configuration; the apply says "give it a trigger"),
  a pod session, and work on a machine (bound to one person's machine).
- **References are names**: repos by URL, connections / MCP servers / skills by
  name, secrets by name, agents by runtime id. An unknown name fails that
  manifest, not the apply.
- **`*File` fields** (`promptFile`, `templateFile`, `systemPromptFile`,
  `agentsMdFile`, `filesFrom`) are paths relative to the manifest; whoever reads
  the directory inlines them (the API for a dir or git source, the CLI for a push).
- **Owner**: everything a source manages is the organization's. A manifest
  cannot make private work.
- Every manifest validates against a zod schema in the API; the same schema is
  served as JSON Schema at `GET /api/config/schema.json` (public, no secrets)
  for editor completion and CI validation.

The other kinds:

| Kind        | Identity | `spec`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Prompt`    | name     | `kind` (prompt / review / job / task), `template` or `templateFile`, `params` (paramsSchema), `defaultAgentType`                                                                                                                                                                                                                                                                                                                                                                                       |
| `Repo`      | `url`    | `defaultBranch`, `imagePreset`, `extraPackages`, `setupCommands`, `defaultAgentType`, review (`reviewEnabled`, `reviewTrigger`, `reviewAgentType`, `reviewModel`, `testCommand`), PR behavior (`autoMerge`, `cautiousMode`, `autoResume`, `maxAutoResumes`), concurrency (`maxConcurrentTasks`, `maxPodInstances`, `maxAgentsPerPod`), pod (`cpu*`, `memory*`, `networkPolicy`, `stallThresholdMs`, `offPeakOnly`) — the fields `PATCH /api/repos/:id` accepts, minus the Slack webhook (a credential) |
| `McpServer` | name     | `command`, `args`, `env` (values may be `${{SECRET_NAME}}`), `installCommand`, `repo` (scope; absent = workspace-wide), `enabled`                                                                                                                                                                                                                                                                                                                                                                      |
| `Skill`     | name     | either `source: { url, ref, path }` (a marketplace skill) or `files: { "SKILL.md": ... }` / `filesFrom: ./dir` (a custom skill), plus `agentTypes`, `repo` (scope), `enabled`                                                                                                                                                                                                                                                                                                                          |

| `Connection` | name | `provider` (slug), `config` (secret fields as `${{SECRET_NAME}}`), `repo` (scope), `enabled`, `assignments: [{ repo?, agentTypes?, permission? }]` |

Not in this plan: **Secrets** (never in files), **Model providers**
(credentials), **Workspaces**.

## Sources

One source per cluster in this version: a **directory** in the API pod, bound
to one workspace.

- `OPTIO_CONFIG_DIR=/etc/optio/config` turns it on; `OPTIO_CONFIG_WORKSPACE=<slug>`
  picks the workspace (default: the oldest, as the sign-in bootstrap picks);
  `OPTIO_CONFIG_PRUNE` (default true) and `OPTIO_CONFIG_INTERVAL` (default 60s).
- The chart grows `configAsCode.enabled`, `configAsCode.configMap` (an existing
  ConfigMap to mount) or `configAsCode.files` (inline, rendered into one), plus
  generic `api.extraVolumes` / `api.extraVolumeMounts` so a sync sidecar or a
  PVC can feed the directory.
- A worker reads the tree every interval and applies it; the apply is
  idempotent (unchanged rows are not written) so a tick with no changes costs a
  few queries. **Sync now** in Settings and `POST /api/config/source/sync` run
  it at once; `?dryRun=true` previews.
- The source is mirrored into `config_sources` at boot (one row, `kind = dir`,
  `origin = env`) so it has an id, a status (last sync at, hash, error,
  summary) and a place in Settings, read-only.

Tables: `config_sources` (workspace, name, kind, path, prune, enabled, origin,
last sync at / hash / error / summary) and `config_objects` (source, kind, name
→ resource kind + id, path, hash, applied_at; unique per (source, kind, name)
and per resource).

## Apply

`config-apply-service.ts`, one function for every source kind and the CLI:

1. Parse every `*.yaml` / `*.yml` under the path (recursively); a parse or
   schema error marks that manifest and continues.
2. Resolve references in the workspace: repo URLs → repos, names → ids, secret
   names → pickable secrets, runtimes → the agent catalog.
3. Plan, per manifest: `create` / `update` / `unchanged` / `error`; `update`
   also covers **drift** — a row someone edited in the UI differs from its
   manifest's desired columns and is put back (reported as reverted); for a
   source, `prune` for each object it manages that no manifest declares;
   `adopt` for an existing unmanaged resource with the manifest's name (so
   exporting a workspace, committing, and syncing takes everything over
   without conflicts).
4. Execute in dependency order — Repo, McpServer, Skill, Prompt, Work — each
   object in its own transaction through the existing write services
   (`createWork` / `updateWork`, extended to persistent agents; the repo, prompt,
   MCP and skill services). A manifest whose derived kind changed (a Job gained
   a repo) is a `replace`: delete and recreate, reported as such.
5. Record the summary on the source (counts + per-manifest errors) and the
   objects in `config_objects`.

`dryRun: true` stops after step 3 and returns the plan; that is `optio config
diff` and the "Preview" button.

## What managed means

- Every list and detail response for the five kinds gains
  `managedBy: { sourceId, sourceName, path } | null` (one decorator,
  `withManagedBy`, like `withOwnerNames`; added to the strict response schemas).
- A managed resource stays editable everywhere (decision 2). The UI says, on
  the row and on its pages, that the file is the truth and edits are reverted
  at the next sync; the sync reports what it reverted.
- **Detach** (admin, `POST /api/config/objects/:id/detach`) drops the
  bookkeeping; the resource becomes ordinary. If its manifest is still in the
  source, the next sync re-adopts it (the file is the truth; remove the file too).

## UI / UX

- **Settings → Config as code** (new card): the directory source — path,
  workspace, last sync (time, counts: created / updated / reverted / pruned /
  unchanged) and the error list per file; **Sync now** and **Preview** (dry
  run) for admins; **Export workspace as YAML**; the schema URL and the CLI
  commands. Without `OPTIO_CONFIG_DIR` the card explains how to turn it on.
- A **Managed** chip (like the Private chip) on Work rows, prompts, repos, MCP
  servers and skills, with the source and path on hover.
- Detail and edit pages of a managed resource: a banner "Managed by config ·
  _path_. Edits here are reverted at the next sync — change the file instead."
  with **View YAML** and (admin) **Detach**.
- **Download YAML** / **Copy as YAML** on every work, prompt, repo, MCP server
  and skill detail page (`GET /api/config/export?kind=&id=`), the way to start a
  config directory from what exists.

## CLI

`optio config` is taken (the CLI's own settings), so these are top-level, the
way kubectl's are:

```
optio export [--kind work|prompt|repo|mcp-server|skill|connection] [--name X] [-o DIR]
optio apply  -f FILE|DIR... [--dry-run]
optio diff   -f FILE|DIR...          # apply --dry-run
optio schema                         # the JSON Schema
```

`export` writes one file per object (`work/<name>.yaml`, `prompts/<name>.yaml`,
…) with `*File` fields split out for long prompts; `apply` inlines them, posts
`POST /api/config/apply { manifests: [{ path, document }], dryRun }` and prints
the plan as a table. A CLI apply is a plain upsert: it manages nothing and never
prunes. Both honor `--json`.

## Permissions

Apply, sync and detach: workspace **admin**. Export: member (only the
organization's resources — never anyone's private ones, never secret values,
never webhook secrets). The schema is public.

## Testing

Unit: parse / normalize / export round-trip for every kind, `when` mapping,
name resolution. Integration: plan + execute against Postgres — create, update,
unchanged, drift reverted, prune, adopt, replace, per-manifest errors, detach. Pipeline e2e: `POST /api/config/apply` over HTTP then
`GET /api/work` shows `managedBy`; boot with `OPTIO_CONFIG_DIR` and the objects
appear. Playwright: the Settings card, the chip, the read-only detail page.
Live: a ConfigMap-mounted directory via Helm values on the local cluster; the Job
it declares appears and runs.

## Decisions (confirmed 2026-10-04)

1. **Kinds**: `Work`, `Prompt`, `Repo`, `McpServer`, `Skill` **and `Connection`**.
   A connection's secret fields are written as `${{SECRET_NAME}}` references;
   a literal value in a secret field is refused at apply, and an export writes
   the reference (`${{<CONFIG_KEY>}}`, the name the pod falls back to) in place
   of any stored literal.
2. **Managed resources stay editable.** No 409: the UI shows the Managed chip
   and a banner saying edits are reverted at the next sync. The sync compares
   the manifest's desired columns with the row and puts the file's version back,
   reporting what it reverted. **Detach** (admin) stops that for one resource.
3. **One source kind: a directory** in the API pod (`OPTIO_CONFIG_DIR`, mounted
   by the chart from a ConfigMap, a PVC, or a git-sync sidecar through
   `extraVolumes`). No repository polling from the API and no push source; the
   CLI's `apply` is a plain upsert that manages nothing. The tables keep a
   `kind` column so other source kinds can come later.
4. **Prune by default** (`OPTIO_CONFIG_PRUNE=false` turns it off).

## Out of scope

Secrets as manifests; repositories polled by the API and CI push sources (the
tables are ready for them); templating / overlays (Kustomize-style);
multi-workspace manifests (a source is one workspace's); importing from other
tools.
