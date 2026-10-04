-- Config as code (docs/plans/config-as-code.md): resources declared as YAML
-- manifests in a directory the API pod reads, applied by a worker.
--
-- `config_sources`: where a workspace's manifests come from. One kind today
-- (`dir`, declared by OPTIO_CONFIG_DIR and mirrored here at boot so it has an
-- id and a status); the column is there for repositories and pushes later.
CREATE TABLE IF NOT EXISTS "config_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'dir',
  "path" text NOT NULL,
  "prune" boolean NOT NULL DEFAULT true,
  "enabled" boolean NOT NULL DEFAULT true,
  "origin" text NOT NULL DEFAULT 'env',
  "last_sync_at" timestamp with time zone,
  "last_sync_hash" text,
  "last_sync_error" text,
  "last_sync_result" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "config_sources_workspace_name_key"
  ON "config_sources" (COALESCE("workspace_id", '00000000-0000-0000-0000-000000000000'::uuid), "name");
--> statement-breakpoint
-- `config_objects`: what each source manages — the manifest (kind, name, file)
-- and the row it became. One source per resource; one resource per
-- (source, kind, name). Pruning deletes what a source no longer declares;
-- detaching deletes the row here and leaves the resource.
CREATE TABLE IF NOT EXISTS "config_objects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_id" uuid NOT NULL REFERENCES "config_sources"("id") ON DELETE CASCADE,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "path" text NOT NULL,
  "resource_table" text NOT NULL,
  "resource_id" uuid NOT NULL,
  "hash" text,
  "applied_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "config_objects_source_kind_name_key"
  ON "config_objects" ("source_id", "kind", "name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "config_objects_resource_key"
  ON "config_objects" ("resource_table", "resource_id");
