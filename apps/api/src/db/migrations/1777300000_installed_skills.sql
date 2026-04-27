-- Phase 2 of community-skills (issue #497):
-- Marketplace-sourced skills. The sync worker shallow-clones source_url@ref,
-- resolves to an immutable SHA stored in resolved_sha, and parks the contents
-- in a content-addressable cache PVC. Tasks materialize the cached files into
-- the worktree at .claude/skills/<name>/. Re-syncing only when the user
-- advances the ref keeps task setups reproducible.

CREATE TABLE "installed_skills" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"                  text NOT NULL,
  "description"           text,
  "source_type"           text NOT NULL DEFAULT 'git',
  "source_url"            text NOT NULL,
  "ref"                   text NOT NULL DEFAULT 'main',
  "resolved_sha"          text,
  "subpath"               text NOT NULL DEFAULT '.',
  "scope"                 text NOT NULL DEFAULT 'global',
  "repo_url"              text,
  "workspace_id"          uuid,
  "agent_types"           jsonb,
  "enabled"               boolean NOT NULL DEFAULT true,
  "last_synced_at"        timestamptz,
  "last_sync_error"       text,
  "cached_manifest"       jsonb,
  "has_executable_files"  boolean NOT NULL DEFAULT false,
  "total_size_bytes"      integer,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "installed_skills_scope_idx" ON "installed_skills" ("scope");
CREATE INDEX "installed_skills_repo_url_idx" ON "installed_skills" ("repo_url");
CREATE INDEX "installed_skills_resolved_sha_idx" ON "installed_skills" ("resolved_sha");
