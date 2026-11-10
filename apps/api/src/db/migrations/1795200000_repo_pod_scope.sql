-- What a repository's pods are shared across: "repo" (one long-lived pod per
-- repo and execution boundary, a worktree per run) or "run" (every task and
-- PR review gets a pod of its own). Null: the deployment's default
-- (OPTIO_POD_SCOPE, Helm agent.podScope; "repo" when unset).
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "pod_scope" text;
