# Config as code

Optio's resources — Jobs, scheduled Tasks, persistent agents, prompts, repos,
MCP servers, skills and connections — can live as YAML **manifests** in a
directory a cluster reads. The files are the truth: a manifest that changes is
applied, one that disappears is pruned, and a managed resource someone edits in
the UI is put back at the next sync. `optio export` writes what a workspace has
as manifests; `optio apply` applies a file or a directory by hand. Design and
decisions: [plans/config-as-code.md](plans/config-as-code.md).

## A manifest

One YAML document per resource; a file may hold several, separated by `---`.

```yaml
# yaml-language-server: $schema=https://optio.example.com/api/config/schema.json
apiVersion: optio/v1
kind: Work
metadata:
  name: nightly-dependency-bump # the identity: unique per workspace and kind
  description: Bumps dependencies every weeknight and opens a PR
spec:
  when:
    schedule: "0 3 * * 1-5"
  where:
    repo: https://github.com/acme/api
    branch: main
  who:
    runtime: claude-code
    options: { model: claude-sonnet-4-5, effort: high }
  what:
    promptFile: ./prompts/dependency-bump.md
    runTitle: "Dependency bump"
  then: until-merged
  secrets: [GITHUB_TOKEN, NPM_TOKEN]
  environment:
    connections: { add: [Linear] }
    review: { enabled: true, trigger: on_pr }
```

The JSON Schema every manifest validates against is served at
`GET /api/config/schema.json` (public) — point your editor's YAML language
server at it, or validate in CI with any JSON Schema tool (`optio schema`
prints it).

### Kinds

| Kind         | Identity        | `spec`                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Work`       | `metadata.name` | `when`, `where`, `who`, `what`, `then` (the New work form's attributes), `mergeWhenReady`, `retries`, `priority`, `secrets` (pod secrets by name), `environment` (connections / MCP servers / skills by **name**, setup commands, review, cautious mode, resume cap), `agent` (a persistent agent's slug, prompts, pod), `params`, `limits`, `pods`, `enabled` |
| `Prompt`     | `metadata.name` | `kind` (prompt / review / job / task), `template` or `templateFile`, `params`, `defaultAgentType`                                                                                                                                                                                                                                                              |
| `Repo`       | `spec.url`      | `defaultBranch` and any of the settings `PATCH /api/repos/:id` takes (image, setup commands, review, PR behavior, concurrency, pod resources). **Only the settings a manifest names are managed**; the rest keep their values. The Slack webhook (a credential) isn't one of them.                                                                             |
| `McpServer`  | `metadata.name` | `command`, `args`, `env` (values may be `${{SECRET_NAME}}`), `installCommand`, `repo` (scope), `enabled`                                                                                                                                                                                                                                                       |
| `Skill`      | `metadata.name` | a custom skill — `prompt` / `promptFile` / `filesFrom` (a directory: `SKILL.md` is the prompt, the rest the files), `layout`, `files` — or a marketplace one — `source: { url, ref, path }`; plus `agentTypes`, `repo`, `enabled`                                                                                                                              |
| `Connection` | `metadata.name` | `provider` (slug), `config` (secret fields as `${{SECRET_NAME}}` references), `repo` (scope), `enabled`, `assignments: [{ repo?, agentTypes?, permission? }]`                                                                                                                                                                                                  |

### Rules

- **`when`** has one key, the trigger type, holding that trigger's config:
  `schedule: "<cron>"`, `webhook: { path }`, `ticket: { source, labels? }`,
  `github: {…}`, `slack: {…}`, `linear: {…}`. Absent = on demand. A webhook's
  signing secret is never in a file; set it once through the trigger API and
  it is kept across applies.
- **`then`** is `exits` (default), `until-merged` (needs `where.repo`), or
  `waits-for-messages` (a persistent agent, with `agent: { slug, systemPrompt |
systemPromptFile, agentsMd | agentsMdFile, podLifecycle }`). A Task that runs
  once (`exits`, a repo, no `when`) is a run, not configuration, and is refused;
  so is work on a machine.
- **`who.runtime`** is an agent runtime id, or `shell` for a Job that runs its
  prompt as a command.
- **References are names.** Repos by URL, connections / MCP servers / skills by
  name, secrets by name, agents by runtime id. An unknown name fails that
  manifest alone. A repo a manifest names must be registered (a `Repo`
  manifest next to it does that; kinds apply in dependency order).
- **Secrets are never in files.** `secrets:` lists pod secrets by name; a
  connection's or MCP server's credential fields are `${{SECRET_NAME}}`
  references, and a literal value in a credential field is refused. An export
  writes the reference (`${{<CONFIG_KEY>}}`, the name the pod falls back to)
  in place of any stored literal.
- **`*File` fields** (`promptFile`, `templateFile`, `systemPromptFile`,
  `agentsMdFile`, `filesFrom`) name files next to the manifest. Whoever reads
  the directory inlines them — the API for the configuration directory, the CLI
  for `apply` — and a field given both ways is an error.
- Everything a manifest declares is **the organization's**. Private work,
  prompts and the like are not expressible, and a manifest whose name collides
  with someone's private resource fails.

## The configuration directory

One directory per cluster, bound to one workspace, declared by the deployment:

| Env                      | Helm                      | Meaning                                                                   |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------- |
| `OPTIO_CONFIG_DIR`       | `configAsCode.mountPath`  | The directory in the API pod. Set = config as code is on.                 |
| `OPTIO_CONFIG_WORKSPACE` | `configAsCode.workspace`  | The workspace's slug. Default: the oldest workspace (the organization's). |
| `OPTIO_CONFIG_PRUNE`     | `configAsCode.prune`      | Delete resources whose manifest is gone (default `true`).                 |
| `OPTIO_CONFIG_INTERVAL`  | `configAsCode.intervalMs` | How often the directory is read (default 60000 ms, at least 10000).       |

The chart mounts the directory from inline manifests (`configAsCode.files`,
rendered into a ConfigMap), from a ConfigMap you maintain
(`configAsCode.configMap`), or from anything you mount at `mountPath` with
`api.extraVolumes` / `api.extraVolumeMounts` (a PVC, a sync sidecar's volume).
A changed ConfigMap needs no pod roll: the mount updates in place and the next
tick reads it.

Every interval (and once at boot) the sync worker reads every `*.yaml` /
`*.yml` under the directory and **applies** it:

1. Each document is validated and resolved; a file that doesn't parse or a
   manifest that names something unknown is one error item, the rest apply.
2. Per manifest: **create** when nothing has its name; **adopt** an existing
   unmanaged resource with its name (so `optio export`, commit, mount takes a
   workspace over without conflicts); **update** when the row differs from
   what the manifest would write — including **drift**, a row someone edited in
   the UI, which is put back and reported as reverted; **unchanged** otherwise;
   **replace** (delete and recreate, run history lost) when the row can't be
   changed in place — a Job that gained a repo, an MCP server that moved scope,
   a connection that changed provider.
3. **Prune**: what the directory managed and no longer declares is deleted
   (off with `OPTIO_CONFIG_PRUNE=false`: orphans are then only reported).

Kinds apply in dependency order (Repo, McpServer, Skill, Connection, Prompt,
Work), each manifest on its own, so a Work manifest can name the connection
declared next to it. The apply is idempotent: rows that already match aren't
written, so a quiet tick costs a few queries.

**Settings → Config as code** shows the directory, its workspace, the last sync
(time, counts, every error with its file) and has **Sync now** and **Preview**
(a dry run) for admins. `POST /api/config/source/sync[?dryRun=true]` is the
same over HTTP. The source is mirrored into `config_sources`; what it manages
is in `config_objects` (manifest kind + name → the row).

### Managed resources

A resource the directory manages carries `managedBy` (source, file, kind) in
every list and detail response, shows a **Managed** chip next to its name, and
a banner on its pages saying edits are put back at the next sync. It stays
editable — operating it (run now, cancel, message an agent) and even editing
it is allowed; the file just wins. **Detach** (admin, on the banner or
`POST /api/config/objects/:id/detach`) stops that for one resource: it becomes
ordinary. If its manifest is still in the directory, the next sync adopts it
again — remove the file too.

## The CLI

```
optio export [--kind work,prompt,…] [--name X] [-o DIR]   # the organization's resources as manifests
optio apply  -f FILE|DIR... [--dry-run]                     # create / update what the manifests describe
optio diff   -f FILE|DIR...                                 # apply --dry-run
optio schema                                                # the JSON Schema
```

`export -o optio/` writes one file per resource (`work/<name>.yaml`,
`prompts/<name>.yaml`, `repos/…`, `mcp-servers/…`, `skills/…`,
`connections/…`), each with the schema comment; without `-o` it prints one YAML
stream. `apply` reads files and directories, inlines `*File` fields, posts the
documents to `POST /api/config/apply` and prints one line per manifest
(`create` / `update` / `unchanged` / `adopt` / `replace` / `error`) and a
summary; exit code 1 when any manifest failed. **A CLI apply is a plain
upsert**: it manages nothing and never prunes — that is the directory's job.

Every page about a work definition, prompt, repo, MCP server, skill or
connection also offers **Download YAML**, and Settings → Config as code
**Export workspace as YAML** (`GET /api/config/export.yaml`).

## Permissions

| Call                                                              | Who                                            |
| ----------------------------------------------------------------- | ---------------------------------------------- |
| `GET /api/config/schema.json`                                     | public                                         |
| `GET /api/config/status`, `GET /api/config/export[.yaml]`         | any member (the organization's resources only) |
| `POST /api/config/apply`, `…/source/sync`, `…/objects/:id/detach` | workspace admin                                |

## Code

`apps/api/src/services/config/`: `apply.ts` (the engine), `kinds/*.ts` (one
handler per kind: desire / find / diff / create / update / remove / export),
`context.ts` (name resolution), `files.ts` (reading a directory), `source.ts`
(the env-declared directory, its row and sync), `managed.ts` (`withManagedBy`),
`export.ts`. Schemas in `schemas/config.ts`; routes in `routes/config.ts`; the
worker in `workers/config-sync-worker.ts`. Shared types and the `*File`
inlining in `packages/shared/src/config/`. CLI commands in
`apps/cli/src/commands/{apply,export,schema}.ts`.
