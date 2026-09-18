-- Optio Local blueprints can run as a first-class agent session, not just a
-- plain shell command. When `agent` is set, the daemon spawns via its agent
-- path (claude/codex/cursor/gemini/opencode) and the rendered commandTemplate
-- is the agent's prompt — so automation-spawned (webhook/schedule/ticket)
-- agent terminals get the same attention hooks as hand-started ones and enter
-- the "needs you" queue while alive, instead of running as a bare command
-- that only ever registers on exit.

ALTER TABLE "local_blueprints" ADD COLUMN "agent" text;
