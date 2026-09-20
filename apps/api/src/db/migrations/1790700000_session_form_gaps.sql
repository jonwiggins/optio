-- Fields the New session form promises that the rows it creates could not
-- carry:
--   users.username             — the provider handle (GitHub login, GitLab
--                                username) so event triggers can prefill
--                                "your login" from the signed-in account.
--   interactive_sessions.title — the name given to a pod session.
--   local_blueprints.base_branch — "new branch that becomes a PR" for Local
--                                automations: the agent's prompt is wrapped
--                                with branch-and-PR instructions off this base.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "username" text;
ALTER TABLE "interactive_sessions" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "local_blueprints" ADD COLUMN IF NOT EXISTS "base_branch" text;
