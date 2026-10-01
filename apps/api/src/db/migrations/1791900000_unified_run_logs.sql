-- One log table for every agent run. Persistent-agent turn logs move into
-- task_logs, keyed by their turn (deleting a turn — or its agent, which
-- deletes its turns — still deletes its logs). Rows keep their ids and
-- timestamps. Job-run logs follow when Job runs move into work_runs.
ALTER TABLE "task_logs" ADD COLUMN IF NOT EXISTS "persistent_agent_turn_id" uuid
  REFERENCES "persistent_agent_turns"("id") ON DELETE CASCADE;
--> statement-breakpoint
INSERT INTO "task_logs" ("id", "persistent_agent_turn_id", "stream", "content", "log_type", "metadata", "timestamp")
SELECT "id", "turn_id", "stream", "content", "log_type", "metadata", "timestamp"
FROM "persistent_agent_turn_logs";
--> statement-breakpoint
DROP TABLE "persistent_agent_turn_logs";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_logs_persistent_agent_turn_id_idx"
  ON "task_logs" ("persistent_agent_turn_id", "timestamp")
  WHERE "persistent_agent_turn_id" IS NOT NULL;
