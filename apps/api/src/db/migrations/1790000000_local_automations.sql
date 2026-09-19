-- Optio Local automations: agent session mode (stay open vs exit when done)
-- on blueprints, and the agent CLI's own session id on terminals so an exited
-- run can be resumed as an interactive chat.

ALTER TABLE "local_blueprints" ADD COLUMN "session_mode" text DEFAULT 'interactive' NOT NULL;
ALTER TABLE "local_terminals" ADD COLUMN "agent_session_id" text;
