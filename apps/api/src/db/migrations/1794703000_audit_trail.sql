-- The audit trail (docs/audit.md): the action log (`optio_actions`) records
-- sign-ins, merges, tokens, membership and settings changes too, the Audit
-- page filters and exports it, and a daily sweep prunes it after a retention
-- period. Additive: one nullable column, one index, one settings table.

-- The client address of the request that did it (through the trusted proxy:
-- OPTIO_TRUST_PROXY), kept out of `params` so the members' Activity feed
-- never shows it.
ALTER TABLE "optio_actions" ADD COLUMN IF NOT EXISTS "client_ip" text;

-- The Audit page and its export read one workspace's rows by time.
CREATE INDEX IF NOT EXISTS "optio_actions_workspace_created_idx"
  ON "optio_actions" ("workspace_id", "created_at" DESC);

-- Deployment-wide audit settings: one row (id 1). `retention_days` null =
-- OPTIO_AUDIT_RETENTION_DAYS (default 365); `last_pruned_at` is when the
-- sweep last finished a pass, so it runs once a day whichever replica ticks.
CREATE TABLE IF NOT EXISTS "audit_settings" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "retention_days" integer,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "last_pruned_at" timestamptz,
  CONSTRAINT "audit_settings_single_row" CHECK ("id" = 1),
  CONSTRAINT "audit_settings_retention_check" CHECK ("retention_days" IS NULL OR "retention_days" BETWEEN 1 AND 36500)
);
