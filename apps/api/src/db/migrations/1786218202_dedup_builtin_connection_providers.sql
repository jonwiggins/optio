-- Deduplicate built-in connection providers and prevent re-duplication.
--
-- seedBuiltInProviders() upserts with ON CONFLICT (slug, workspace_id), but
-- built-in providers have workspace_id = NULL and the unique constraint
-- treats NULLs as distinct, so the conflict never fired and every API
-- restart inserted a fresh copy of each built-in provider.
--
-- Re-point any connections at the oldest copy of each slug, delete the
-- newer duplicates, and add a partial unique index on (slug) for the
-- NULL-workspace rows so the seeder's upsert has a real conflict target.

WITH canonical AS (
  SELECT DISTINCT ON (slug) id, slug
  FROM connection_providers
  WHERE workspace_id IS NULL
  ORDER BY slug, created_at ASC, id ASC
),
dups AS (
  SELECT cp.id AS dup_id, c.id AS keep_id
  FROM connection_providers cp
  JOIN canonical c ON c.slug = cp.slug
  WHERE cp.workspace_id IS NULL AND cp.id <> c.id
)
UPDATE connections
SET provider_id = dups.keep_id
FROM dups
WHERE connections.provider_id = dups.dup_id;--> statement-breakpoint

WITH canonical AS (
  SELECT DISTINCT ON (slug) id, slug
  FROM connection_providers
  WHERE workspace_id IS NULL
  ORDER BY slug, created_at ASC, id ASC
)
DELETE FROM connection_providers cp
USING canonical c
WHERE cp.workspace_id IS NULL
  AND cp.slug = c.slug
  AND cp.id <> c.id;--> statement-breakpoint

CREATE UNIQUE INDEX "connection_providers_slug_builtin_key"
  ON "connection_providers" ("slug")
  WHERE "workspace_id" IS NULL;
