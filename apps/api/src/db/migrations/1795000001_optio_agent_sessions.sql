-- Preserve the legacy default conversation while allowing independent named sessions.
ALTER TABLE interactive_sessions ADD COLUMN assistant_default boolean NOT NULL DEFAULT false;
UPDATE interactive_sessions SET assistant_default = true WHERE assistant;
DROP INDEX interactive_sessions_assistant_owner_key;
CREATE UNIQUE INDEX interactive_sessions_assistant_owner_key ON interactive_sessions
  (COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
   COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE assistant AND assistant_default AND state = 'active';
