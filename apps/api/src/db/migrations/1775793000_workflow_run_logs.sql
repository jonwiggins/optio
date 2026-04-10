CREATE TABLE "workflow_run_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_run_id" uuid NOT NULL REFERENCES "workflow_runs"("id") ON DELETE CASCADE,
  "stream" text DEFAULT 'stdout' NOT NULL,
  "content" text NOT NULL,
  "log_type" text,
  "metadata" jsonb,
  "timestamp" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "workflow_run_logs_run_id_timestamp_idx" ON "workflow_run_logs" ("workflow_run_id", "timestamp");
