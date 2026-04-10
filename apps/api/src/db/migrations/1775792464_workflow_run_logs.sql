ALTER TABLE "task_logs" ADD COLUMN "workflow_run_id" uuid;--> statement-breakpoint
CREATE INDEX "task_logs_workflow_run_id_idx" ON "task_logs" USING btree ("workflow_run_id");
