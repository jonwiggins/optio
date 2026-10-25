-- Model gateway (docs/model-gateway.md): a model provider of kind "gateway"
-- is an Anthropic- / OpenAI-compatible endpoint inside the network (LiteLLM).
-- Additive: upstream's Bedrock columns stay; region becomes optional since
-- a gateway has none. A workspace names one gateway as its default — what
-- the New work form offers and the setup wizard creates.

ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "base_url" text;
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "auth_header" text NOT NULL DEFAULT 'bearer';
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "sync_url" text;
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "last_synced_at" timestamptz;
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "token_source" text NOT NULL DEFAULT 'personal';
ALTER TABLE "model_providers" ALTER COLUMN "region" DROP NOT NULL;

ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "default_model_provider_id" uuid REFERENCES "model_providers"("id") ON DELETE SET NULL;
