-- Fresh pod per run (services/pod-mode.ts): a repo's work can run in a pod
-- made for that one run and removed when it ends, instead of the repo's
-- shared pods. Off by default: every existing repo and workspace stays
-- "shared".
--
-- repos.pod_mode: "shared" | "per_run"; null follows the workspace.
-- workspaces.pod_mode: the default for its repos, or "per_run_required"
-- (always a fresh pod, whatever a repo picks).
-- agent_pods.per_run_base_key: set on a fresh pod only (the isolation key
-- the run would have shared pods under), so the repo's instance limit can
-- count them and they are removed when their run ends.
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "pod_mode" text;
--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_pod_mode_check"
  CHECK ("pod_mode" IS NULL OR "pod_mode" IN ('shared', 'per_run'));
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "pod_mode" text NOT NULL DEFAULT 'shared';
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_pod_mode_check"
  CHECK ("pod_mode" IN ('shared', 'per_run', 'per_run_required'));
--> statement-breakpoint
ALTER TABLE "agent_pods" ADD COLUMN IF NOT EXISTS "per_run_base_key" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_pods_per_run_idx" ON "agent_pods" ("pool", "pool_key", "per_run_base_key")
  WHERE "per_run_base_key" IS NOT NULL;
