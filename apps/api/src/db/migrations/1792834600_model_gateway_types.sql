-- Model gateway types (docs/model-gateway.md "Gateway types"): a gateway is
-- LiteLLM, OpenRouter, Portkey or a generic OpenAI- / Anthropic-compatible
-- endpoint, and its type decides which gateway features Settings offers.
-- Additive: two nullable columns. Every gateway saved before types existed
-- was a LiteLLM one and is marked so; a Bedrock row keeps null.
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "gateway_type" text;
UPDATE "model_providers" SET "gateway_type" = 'litellm'
  WHERE "kind" = 'gateway' AND "gateway_type" IS NULL;

-- The gateway's own id for a key Optio made, when it isn't the SHA-256 of
-- the key (`key_hash`, LiteLLM's id): OpenRouter's hash, Portkey's UUID.
-- Null for every key made before, all of them LiteLLM's.
ALTER TABLE "gateway_issued_keys" ADD COLUMN IF NOT EXISTS "gateway_key_id" text;
