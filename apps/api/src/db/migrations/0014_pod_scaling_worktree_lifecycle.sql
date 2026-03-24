-- Pod scaling: add per-repo scaling config
ALTER TABLE "repos" ADD COLUMN "max_pod_instances" integer NOT NULL DEFAULT 1;
ALTER TABLE "repos" ADD COLUMN "max_agents_per_pod" integer NOT NULL DEFAULT 2;

-- Allow multiple pods per repo (drop unique constraint on repoUrl)
ALTER TABLE "repo_pods" DROP CONSTRAINT IF EXISTS "repo_pods_repo_url_unique";
ALTER TABLE "repo_pods" ADD COLUMN "instance_index" integer NOT NULL DEFAULT 0;

-- Worktree lifecycle: track worktree state and last pod for same-pod retry
ALTER TABLE "tasks" ADD COLUMN "worktree_state" text DEFAULT 'none';
ALTER TABLE "tasks" ADD COLUMN "last_pod_id" uuid;
