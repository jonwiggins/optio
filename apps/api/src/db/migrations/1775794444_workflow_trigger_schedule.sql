ALTER TABLE "workflow_triggers" ADD COLUMN "last_fired_at" timestamp with time zone;
ALTER TABLE "workflow_triggers" ADD COLUMN "next_fire_at" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "workflow_triggers_schedule_due_idx" ON "workflow_triggers" ("enabled", "next_fire_at");
