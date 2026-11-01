# Repository prompts and optional commit trailers

The built-in task and review prompts use GitLab commands for a GitLab repository and keep GitHub and CodeCommit commands for their respective repositories. A saved repository or default prompt continues to take precedence: the workspace's repository override, then the workspace's default, then the deployment's default, which every workspace without its own reads. A workspace admin saves the workspace's defaults (Settings → Agent prompt and the review prompt); only a deployment admin saves the deployment's (`scope: "deployment"` on `POST /api/prompt-templates`). The built-in prompts are plain constants: no environment variable changes their text.

A deployment admin can choose **Add starter prompts** on the Prompts page. The starters cover common jobs such as a skill, a review, documentation, tests and a refactor. The same control restores missing or edited starters without duplicating them or replacing a person's own prompt with the same name. Starter prompts belong to no workspace and every workspace sees them, which is why a workspace admin cannot restore them, edit them or delete them: a prompt with no workspace is read-only to everyone but a deployment admin. Boot-time seeding is off unless `OPTIO_STARTER_PROMPTS=true` (Helm `prompts.starters`). Linked starter templates select their platform conditional from the repository when instantiated.

## Traceability

Traceability adds the original Jira key, the requester and a link to the run to the pull or merge request and to each commit. It is off for every repository until a deployment admin lists the repositories it applies to in `OPTIO_WORK_TRACEABILITY_REPOS` (Helm `tickets.traceability.repos`): comma-separated repository URLs, or `https://host/group/*` for every repository under a group.

What it writes into the repository's history, which is as public as the repository:

- the requester's display name in the description footer (`Requested by:`). Work created from a ticket names nobody.
- the run's address, `<PUBLIC_URL>/work/<id>`, in the footer and an `Optio-Run:` trailer, which reveals your Optio hostname. It is left out while `PUBLIC_URL` is unset.
- the Jira key, in the title, the footer and a `Jira:` trailer.
- the requester's email, in a `Co-authored-by:` trailer, only when `OPTIO_WORK_TRACEABILITY_EMAIL=true` (Helm `tickets.traceability.requesterEmail`). It is off by default.

Only list repositories whose history may carry these, and leave public repositories out unless that is intended. `OPTIO_COMMIT_TRAILERS=false` (Helm `tickets.commitTrailers`) keeps the description metadata and omits the trailers. A pod installs a chained `prepare-commit-msg` hook; a repository with its own `core.hooksPath` keeps that hook and receives the instructions in its prompt. Local runs receive the metadata as prompt instructions.

Team-name lookup is added by the Teams split, where team ownership exists. The pure trailer helpers already accept a team name. The execution identity and credentials remain those of the existing run owner.
