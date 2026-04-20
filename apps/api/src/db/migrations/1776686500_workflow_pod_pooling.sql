-- Share standalone-workflow pods across runs, scaling out per-workflow.
--
-- Before this change, workflow_pods was keyed by workflow_run_id (one pod per
-- run), matching the initial 1:1 execution model. Runs now share pods within
-- a workflow, pooled up to workflows.max_pod_instances replicas with
-- workflows.max_agents_per_pod concurrent runs each — mirroring repo_pods.
--
-- The old workflow_pods rows and K8s pods are stale artifacts of the 1:1 model
-- and are safe to drop; the running-run table (workflow_runs) retains pod_name
-- for log streaming and is not touched. Existing runs in flight finish against
-- their old K8s pods; orphaned pods get reaped by kubelet / cleanup worker.

ALTER TABLE "workflows"
  ADD COLUMN "max_pod_instances" integer NOT NULL DEFAULT 1,
  ADD COLUMN "max_agents_per_pod" integer NOT NULL DEFAULT 2;

ALTER TABLE "workflow_runs"
  ADD COLUMN "pod_id" uuid,
  ADD COLUMN "last_pod_id" uuid;

CREATE INDEX "workflow_runs_pod_id_idx" ON "workflow_runs" ("pod_id");

DROP TABLE IF EXISTS "workflow_pods";

CREATE TABLE "workflow_pods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "instance_index" integer NOT NULL DEFAULT 0,
  "workspace_id" uuid,
  "pod_name" text,
  "pod_id" text,
  "state" text NOT NULL DEFAULT 'provisioning',
  "active_run_count" integer NOT NULL DEFAULT 0,
  "last_run_at" timestamptz,
  "error_message" text,
  "job_name" text,
  "managed_by" text NOT NULL DEFAULT 'bare-pod',
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT "workflow_pods_workflow_instance_key" UNIQUE ("workflow_id", "instance_index")
);

CREATE INDEX "workflow_pods_workflow_id_idx" ON "workflow_pods" ("workflow_id");
CREATE INDEX "workflow_pods_workspace_id_idx" ON "workflow_pods" ("workspace_id");
