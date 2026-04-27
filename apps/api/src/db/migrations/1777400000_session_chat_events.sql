-- Persist interactive-session chat events so reconnecting clients can see
-- the full conversation. Mirrors the persistent_agent_turn_logs / task_logs
-- shape so the existing log-history UI patterns work without special-casing.
--
-- Retention: trimmed by `MAX_SESSION_CHAT_EVENTS` per session at insert time
-- (oldest events deleted first). No time-based pruning yet — sessions are
-- already capped at 30-day TTL.

CREATE TABLE "session_chat_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "interactive_sessions"("id") ON DELETE CASCADE,
  "stream" text NOT NULL DEFAULT 'stdout',
  "content" text NOT NULL,
  "log_type" text,
  "metadata" jsonb,
  "timestamp" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX "session_chat_events_session_idx"
  ON "session_chat_events" ("session_id", "timestamp");
