# Workspaces as code

An organization that gives each team its own workspace can keep those
workspaces in a versioned file instead of clicking each one together:
`kind: Workspace` manifests name a workspace's slug, display name, settings,
members (by email, with a role) and repos. A deployment admin, by hand or from
CI, plans the change (`optio diff`), has it reviewed like any other change,
and applies it (`optio apply`). The format and the CLI are the ones
[config as code](config-as-code.md) uses for the resources inside a workspace.

Nothing changes until a deployment admin applies such a file.

## A manifest

```yaml
# yaml-language-server: $schema=https://optio.example.com/api/config/schema.json
apiVersion: optio/v1
kind: Workspace
metadata:
  name: payments # the slug: the identity
  description: The payments team
spec:
  displayName: Payments
  settings: # only the settings named here are managed
    restrictPodSecrets: true
    allowDockerInDocker: false
    autoJoinDomains: []
    autoJoinRole: member
  members:
    - { email: lead@payments.example.com, role: admin }
    - { email: dev1@payments.example.com } # role defaults to member
    - { email: auditor@example.com, role: viewer }
  prune: false # true: remove members this file doesn't list
  repos: # each one a Repo manifest's spec (docs/config-as-code.md)
    - url: https://gitlab.example.com/payments/api
      defaultBranch: main
      reviewEnabled: true
      maxConcurrentTasks: 3
```

| Field                  | Meaning                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metadata.name`        | The workspace's slug (lowercase letters, digits, dashes). A workspace with this slug is updated; none, and one is created.                                                              |
| `metadata.description` | The workspace's description. Absent = left alone.                                                                                                                                       |
| `spec.displayName`     | The name people see. Absent = the slug for a new workspace, left alone for an existing one.                                                                                             |
| `spec.settings`        | `allowDockerInDocker`, `autoJoinDomains`, `autoJoinRole` (`member` or `viewer`), `restrictPodSecrets`: the settings the workspace's Settings page has. Only the ones named are managed. |
| `spec.members`         | `email` and `role` (`admin`, `member`, `viewer`; default `member`). Listed people are added, or given the listed role.                                                                  |
| `spec.prune`           | `true` removes members the file doesn't list. Default `false`: they stay.                                                                                                               |
| `spec.repos`           | Repos registered in the workspace, each with `url` and any repo setting a `Repo` manifest takes. Only the settings named are managed.                                                   |

### Rules

- **Nothing is removed by omission.** A workspace the file doesn't mention, a
  repo it doesn't list and a setting it doesn't name are left as they are.
  Members are the one thing that can be removed, and only with `prune: true`.
- **Members are matched by verified email.** Only an account whose sign-in
  proved the address counts, so nobody gets into a workspace by claiming an
  email. Someone who hasn't signed in yet is reported as waiting; the next
  apply after their first sign-in adds them. Run the apply from CI on a
  schedule, or again after onboarding, to pick them up.
- **Pruning keeps an admin.** With `prune: true` and no listed admin who has
  signed in, nobody is removed and the workspace's item is an error.
- **The applier isn't added.** A workspace created from a file has the members
  the file lists, not the deployment admin who applied it.
- **Each workspace is its own unit.** A manifest that doesn't validate, or a
  setting the workspace refuses (an auto-join domain that isn't a domain), is
  one error; the other workspaces still apply.
- **Idempotent.** A second apply of the same file reports every item
  `unchanged` and writes nothing.
- Groups from the sign-in directory aren't a way to name members yet: list
  people by email.

## Many team workspaces

Keep one file per team in a repository the platform team owns:

```
optio-workspaces/
  workspaces/
    payments.yaml
    cards.yaml
    lending.yaml
    ...
```

Each file is a manifest like the one above. A file may also hold several,
separated by `---`:

```yaml
apiVersion: optio/v1
kind: Workspace
metadata: { name: cards }
spec:
  displayName: Cards
  settings: { restrictPodSecrets: true }
  members:
    - { email: lead@cards.example.com, role: admin }
    - { email: dev1@cards.example.com }
  repos:
    - { url: https://gitlab.example.com/cards/service, defaultBranch: main }
---
apiVersion: optio/v1
kind: Workspace
metadata: { name: lending }
spec:
  displayName: Lending
  settings: { restrictPodSecrets: true }
  members:
    - { email: lead@lending.example.com, role: admin }
  prune: true
  repos:
    - { url: https://gitlab.example.com/lending/engine, defaultBranch: main }
```

A pipeline that plans on every merge request and applies on the default
branch, with a token of a deployment admin (`OPTIO_TOKEN`, a personal access
token) as a masked CI variable:

```yaml
# .gitlab-ci.yml
stages: [plan, apply]

plan:
  stage: plan
  script:
    - optio diff -f workspaces/
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"

apply:
  stage: apply
  script:
    - optio apply -f workspaces/
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

`optio diff` prints one line per workspace, member and repo
(`create` / `update` / `unchanged` / `prune` / `error`, with the fields that
change) and exits 1 when any item is an error, so a broken file fails the
merge request before anyone applies it.

## Starting from what exists

```
optio export --kind workspace -o optio-workspaces/
```

writes `workspaces/<slug>.yaml` for every workspace: display name,
description, settings, members with a verified email and their role, and repos
with their settings. Commit it, and the first apply reports everything
`unchanged`. An export never writes `prune`, so applying it removes no one;
members whose email isn't verified are left out of it (an apply can't match
them) and stay in their workspaces.

## The API

| Call                                                        | What                                               |
| ----------------------------------------------------------- | -------------------------------------------------- |
| `POST /api/config/workspaces/apply` `{ manifests, dryRun }` | Plan (`dryRun: true`) or apply Workspace manifests |
| `GET /api/config/workspaces/export[.yaml][?slug=a,b]`       | The workspaces (or the named ones) as manifests    |

Both take a deployment admin, acting from a workspace they administer (as
every deployment-wide call does); anyone else gets 403. `optio apply` sends
Workspace manifests to the first and every other kind to the workspace-level
apply, so one directory can hold both. A Workspace manifest sent to the
workspace-level apply (`POST /api/config/apply`, or a workspace's
configuration directory) is refused as an error item.

Every apply that writes is in the action log as `config.workspaces.apply`:
once for the deployment, with the summary, and once in each workspace it
changed, so a team's admins see who changed their workspace.

## Code

`apps/api/src/services/config/workspaces.ts` (apply and export),
`apps/api/src/routes/config-workspaces.ts` (routes), `WorkspaceManifestSchema`
in `apps/api/src/schemas/config.ts`, and the shared `WorkspaceManifest` type in
`packages/shared/src/config/manifest.ts`. Repos go through the workspace-level
apply's `Repo` kind.
