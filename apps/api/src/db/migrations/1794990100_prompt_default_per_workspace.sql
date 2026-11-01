-- Default prompts per workspace: the coding default (`is_default`, no repo,
-- the organization's) is one workspace's row, and a workspace without one
-- reads the deployment's (no workspace), then the built-in prompt
-- (services/prompt-template-service.ts). One default per scope from now on:
-- should a scope hold more than one, the most recently saved stays the
-- default.
UPDATE "prompt_templates" AS pt SET "is_default" = false
WHERE pt."is_default" AND pt."repo_url" IS NULL AND pt."owner_user_id" IS NULL
  AND EXISTS (
    SELECT 1 FROM "prompt_templates" AS o
    WHERE o."is_default" AND o."repo_url" IS NULL AND o."owner_user_id" IS NULL
      AND o."workspace_id" IS NOT DISTINCT FROM pt."workspace_id"
      AND (o."updated_at", o."id") > (pt."updated_at", pt."id")
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_templates_default_scope_key" ON "prompt_templates" (
  COALESCE("workspace_id", '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE "is_default" AND "repo_url" IS NULL AND "owner_user_id" IS NULL;
