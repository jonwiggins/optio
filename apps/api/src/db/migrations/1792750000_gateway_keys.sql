-- Gateway keys made by Optio, and team budgets (docs/model-gateway.md "Keys
-- Optio makes"). Per gateway: which ways people get a token (pasted by hand,
-- made by Optio in LiteLLM, or both), the LiteLLM admin key Optio makes keys
-- with (sealed: AES-256-GCM, AAD `model_provider_admin_key|<id>`, never
-- returned) and what a new key gets. And the keys Optio made, a person's or
-- a team's, so it can rotate and revoke them and warn before their budget
-- runs out. Additive: five nullable columns and one new table.

-- { "personalPasted": bool, "optioIssued": bool }; null = pasting only.
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "key_modes" jsonb;
-- { maxBudget, budgetDuration, models, keyDuration, teamMaxBudget, teamBudgetDuration }.
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "key_defaults" jsonb;
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "encrypted_admin_key" bytea;
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "admin_key_iv" bytea;
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "admin_key_auth_tag" bytea;

-- One key Optio made in LiteLLM. The key itself lives where a pasted one
-- would (the person's or the team's secret named by the gateway); this row
-- keeps LiteLLM's id for it (`key_hash`, the SHA-256 LiteLLM names it by) and
-- what it was given. `user_id` / `team_id` go null when the person or the
-- team is deleted, so the housekeeping check still finds the key and revokes
-- it in LiteLLM.
CREATE TABLE IF NOT EXISTS "gateway_issued_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "provider_id" uuid NOT NULL REFERENCES "model_providers"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "team_id" uuid REFERENCES "teams"("id") ON DELETE SET NULL,
  "secret_name" text NOT NULL,
  "key_hash" text NOT NULL,
  "key_alias" text,
  "key_hint" text,
  "litellm_user_id" text,
  "litellm_team_id" text,
  "models" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "max_budget" numeric,
  "budget_duration" text,
  "expires_at" timestamptz,
  "status" text NOT NULL DEFAULT 'active',
  "revoked_reason" text,
  "revoked_at" timestamptz,
  "spend_usd" numeric,
  "budget_reset_at" timestamptz,
  "checked_at" timestamptz,
  "warned_level" integer NOT NULL DEFAULT 0,
  "warned_period" text,
  "carried_spend" jsonb,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "gateway_issued_keys_kind_check" CHECK ("kind" IN ('person', 'team')),
  CONSTRAINT "gateway_issued_keys_status_check" CHECK ("status" IN ('active', 'revoked'))
);

-- What a person's key carries from their earlier keys: [{ "usd": n, "until":
-- iso | null }], each amount until its own key's budget period ends (then the
-- housekeeping check takes it off the key's spend in LiteLLM). Also added on
-- its own for a database that ran an earlier draft of this file.
ALTER TABLE "gateway_issued_keys" ADD COLUMN IF NOT EXISTS "carried_spend" jsonb;

CREATE INDEX IF NOT EXISTS "gateway_issued_keys_provider_idx" ON "gateway_issued_keys" ("provider_id");
CREATE INDEX IF NOT EXISTS "gateway_issued_keys_user_idx" ON "gateway_issued_keys" ("user_id");
CREATE INDEX IF NOT EXISTS "gateway_issued_keys_team_idx" ON "gateway_issued_keys" ("team_id");
CREATE INDEX IF NOT EXISTS "gateway_issued_keys_active_idx" ON "gateway_issued_keys" ("checked_at") WHERE "status" = 'active';
