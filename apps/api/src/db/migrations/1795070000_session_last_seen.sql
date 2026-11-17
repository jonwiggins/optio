-- When a sign-in session was last used, for the optional idle timeout
-- (OPTIO_SESSION_IDLE_MINUTES / Settings → Access) and the deployment admin's
-- list of a person's sessions. Null on sessions from before this column: they
-- count from their creation until their next use.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;
