-- User-scoped secrets.
--
-- Adds a `user_id` column to the `secrets` table so identity tokens
-- (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, etc.) can be stored at
-- scope = 'user' and resolved per-user rather than shared globally.
-- This keeps identity tokens out of the shared pod env.

ALTER TABLE "secrets"
  ADD COLUMN "user_id" uuid REFERENCES "users"("id");

-- Replace the old unique constraint with one that includes user_id.
-- The old constraint covered (name, scope, workspace_id); the new one
-- adds user_id so multiple users can store the same secret name at
-- user scope.
ALTER TABLE "secrets"
  DROP CONSTRAINT IF EXISTS "secrets_name_scope_ws_key";

ALTER TABLE "secrets"
  ADD CONSTRAINT "secrets_name_scope_ws_user_key"
    UNIQUE ("name", "scope", "workspace_id", "user_id");

CREATE INDEX "secrets_user_id_idx" ON "secrets" ("user_id");

-- CHECK constraint: scope = 'user' iff user_id IS NOT NULL.
ALTER TABLE "secrets"
  ADD CONSTRAINT "secrets_user_scope_check"
    CHECK (
      (scope = 'user' AND user_id IS NOT NULL)
      OR
      (scope <> 'user' AND user_id IS NULL)
    );
