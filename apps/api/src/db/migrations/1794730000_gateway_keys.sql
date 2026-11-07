-- Gateway keys Optio makes (docs/model-gateway.md "Keys Optio makes"). Per
-- gateway: how people get a token (pasted by hand, made by Optio, or both),
-- the admin key Optio makes keys with (sealed: AES-256-GCM, its AAD bound to
-- the gateway, its type and its admin URL; never returned) and what a new key
-- gets. And the keys Optio made, so it can rotate and revoke them and carry a
-- replaced key's spend over. Additive: five nullable columns and one table.

-- { "personalPasted": bool, "optioIssued": bool }; null = pasting only.
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "key_modes" jsonb;
-- { maxBudget, budgetDuration, models, keyDuration }.
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "key_defaults" jsonb;
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "encrypted_admin_key" bytea;
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "admin_key_iv" bytea;
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "admin_key_auth_tag" bytea;

-- One key Optio made for a person. The key itself is the person's gateway
-- token (secret "gateway:<providerId>"); this row keeps the SHA-256 of its
-- value (`key_hash`, also LiteLLM's id for it), the gateway's own id where
-- that differs (`gateway_key_id`, OpenRouter's hash) and what it was given,
-- never the value. `user_id` goes null when the person is deleted, so the
-- housekeeping check still finds the key and blocks it on the gateway.
CREATE TABLE IF NOT EXISTS "gateway_issued_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "provider_id" uuid NOT NULL REFERENCES "model_providers"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "key_hash" text NOT NULL,
  "gateway_key_id" text,
  "key_alias" text,
  "key_hint" text,
  "litellm_user_id" text,
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
  -- [{ "usd": n, "until": iso | null }]: what the key carries from the
  -- person's earlier keys, each amount until its own key's period ends.
  "carried_spend" jsonb,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "gateway_issued_keys_status_check" CHECK ("status" IN ('active', 'revoked'))
);

CREATE INDEX IF NOT EXISTS "gateway_issued_keys_provider_idx" ON "gateway_issued_keys" ("provider_id");
CREATE INDEX IF NOT EXISTS "gateway_issued_keys_user_idx" ON "gateway_issued_keys" ("user_id");
CREATE INDEX IF NOT EXISTS "gateway_issued_keys_active_idx" ON "gateway_issued_keys" ("checked_at") WHERE "status" = 'active';
