# Repo Tasks — examples

Agents that run in a git worktree and end by opening a pull request. See
[../../docs/tasks.md](../../docs/tasks.md) for the underlying model.

> Examples coming. The shape will be:
>
> ```
> my-example/
> ├── README.md
> ├── task.json     # body of POST /api/tasks with type: "repo-blueprint"
> └── setup.sh
> ```
>
> Good candidates to write next:
>
> - **`triage-bot`** — webhook trigger; receives a GitHub issue payload, drafts a
>   triage comment, opens a PR with the suggested fix if it's small.
> - **`dependency-updater`** — schedule trigger (weekly); reads `package.json`,
>   bumps non-major deps, runs tests, opens one PR per package.
> - **`changelog-writer`** — webhook trigger on PR-merged; appends to
>   `CHANGELOG.md` based on the merged commits.

Open a PR if you'd like to contribute one — copy the
[`forge`](../persistent-agents/forge/) shape and adapt to a single-task
blueprint.
