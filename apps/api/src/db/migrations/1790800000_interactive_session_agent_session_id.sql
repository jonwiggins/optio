-- Claude Code session id for interactive session chat. The chat WS captures it
-- from the first `claude -p` turn and passes `--resume <id>` on every later
-- turn, so the conversation survives WebSocket reconnects. Null = no turn yet
-- (or the stored session vanished and the next turn starts fresh).
ALTER TABLE "interactive_sessions" ADD COLUMN IF NOT EXISTS "agent_session_id" text;
