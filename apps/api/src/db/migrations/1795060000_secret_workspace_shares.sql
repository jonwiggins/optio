-- A deployment admin may share one of the deployment's own secrets (scope
-- `global`, no workspace, no user) with every workspace or with chosen ones
-- (docs/scope.md, "Sharing a deployment secret"). Two new tables, `secrets`
-- itself unchanged; nothing is shared for any existing row: until a secret is
-- shared, only the founding workspace's work uses it by name, as before.
CREATE TABLE IF NOT EXISTS "secret_all_workspace_shares" (
  "secret_id" uuid PRIMARY KEY REFERENCES "secrets"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secret_workspace_shares" (
  "secret_id" uuid NOT NULL REFERENCES "secrets"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("secret_id", "workspace_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_workspace_shares_workspace_id_idx" ON "secret_workspace_shares" ("workspace_id");
