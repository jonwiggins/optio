-- One pod table. Every pod Optio runs agents in — a repo's pods, a Job's
-- pooled pods, a persistent agent's pod — is a row of agent_pods, keyed by
-- the pool it belongs to and what that pool is shared across:
--   pool = 'repo'             pool_key = the normalized repo URL
--   pool = 'standalone'       pool_key = the Job (definition) id
--   pool = 'persistent-agent' pool_key = the agent id
-- Rows keep their ids (interactive sessions, pod health events, and runs
-- point at them). Per-pool semantics are unchanged: repo pods carry no
-- workspace, a Job's (key, instance) pair stays unique, and an agent pod's
-- NULL keep_warm_until still means always-on. Pods outlive deleted owners
-- until the idle reaper (or the owner's delete path) removes them, instead of
-- the old row cascade that orphaned the running pod.
CREATE TYPE "agent_pod_state" AS ENUM ('provisioning', 'ready', 'error', 'terminating');
--> statement-breakpoint
CREATE TABLE "agent_pods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pool" text NOT NULL,
  "pool_key" text NOT NULL,
  "instance_index" integer DEFAULT 0 NOT NULL,
  "workspace_id" uuid,
  "repo_branch" text,
  "pod_name" text,
  "pod_id" text,
  "state" "agent_pod_state" DEFAULT 'provisioning' NOT NULL,
  "active_count" integer DEFAULT 0 NOT NULL,
  "last_used_at" timestamp with time zone,
  "keep_warm_until" timestamp with time zone,
  "error_message" text,
  "managed_by" text DEFAULT 'bare-pod' NOT NULL,
  "statefulset_name" text,
  "job_name" text,
  "cache_pvc_name" text,
  "cache_pvc_state" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_pods_pool_check" CHECK ("pool" IN ('repo', 'standalone', 'persistent-agent'))
);
--> statement-breakpoint
INSERT INTO "agent_pods" (
  "id", "pool", "pool_key", "instance_index", "workspace_id", "repo_branch", "pod_name", "pod_id",
  "state", "active_count", "last_used_at", "error_message", "managed_by", "statefulset_name",
  "cache_pvc_name", "cache_pvc_state", "created_at", "updated_at"
)
SELECT
  "id", 'repo', "repo_url", "instance_index", "workspace_id", "repo_branch", "pod_name", "pod_id",
  "state"::text::"agent_pod_state", "active_task_count", "last_task_at", "error_message",
  "managed_by", "statefulset_name", "cache_pvc_name", "cache_pvc_state", "created_at", "updated_at"
FROM "repo_pods";
--> statement-breakpoint
INSERT INTO "agent_pods" (
  "id", "pool", "pool_key", "instance_index", "workspace_id", "pod_name", "pod_id", "state",
  "active_count", "last_used_at", "error_message", "managed_by", "job_name", "created_at",
  "updated_at"
)
SELECT
  "id", 'standalone', "workflow_id"::text, "instance_index", "workspace_id", "pod_name", "pod_id",
  "state"::text::"agent_pod_state", "active_run_count", "last_run_at", "error_message",
  "managed_by", "job_name", "created_at", "updated_at"
FROM "workflow_pods";
--> statement-breakpoint
INSERT INTO "agent_pods" (
  "id", "pool", "pool_key", "workspace_id", "pod_name", "pod_id", "state", "last_used_at",
  "keep_warm_until", "error_message", "managed_by", "job_name", "created_at", "updated_at"
)
SELECT
  "id", 'persistent-agent', "agent_id"::text, "workspace_id", "pod_name", "pod_id",
  "state"::text::"agent_pod_state", "last_turn_at", "keep_warm_until", "error_message",
  "managed_by", "job_name", "created_at", "updated_at"
FROM "persistent_agent_pods";
--> statement-breakpoint
DROP TABLE "repo_pods";
--> statement-breakpoint
DROP TABLE "workflow_pods";
--> statement-breakpoint
DROP TABLE "persistent_agent_pods";
--> statement-breakpoint
DROP TYPE "repo_pod_state";
--> statement-breakpoint
DROP TYPE "workflow_pod_state";
--> statement-breakpoint
CREATE INDEX "agent_pods_pool_key_idx" ON "agent_pods" ("pool", "pool_key");
--> statement-breakpoint
CREATE INDEX "agent_pods_workspace_id_idx" ON "agent_pods" ("workspace_id");
--> statement-breakpoint
CREATE INDEX "agent_pods_statefulset_name_idx" ON "agent_pods" ("statefulset_name");
--> statement-breakpoint
CREATE INDEX "agent_pods_keep_warm_idx" ON "agent_pods" ("keep_warm_until")
  WHERE "keep_warm_until" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_pods_standalone_instance_key" ON "agent_pods" ("pool_key", "instance_index")
  WHERE "pool" = 'standalone';
