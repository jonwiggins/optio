-- Connections v2 (docs/connections.md): a connection is a named account at a
-- service made of parts — credentials, tools (MCP), shell env, a note.
--
-- Providers declare the new parts: `shell_env` (vars exported into the
-- agent's own shell, `{{key}}` templates over the connection's config),
-- `note` (text given to the agent as a skill file), `health_check` (how
-- "Test" checks the account). The MCP config's `env` / `enabledBy` live
-- inside the existing `mcp_config` jsonb.
ALTER TABLE "connection_providers" ADD COLUMN IF NOT EXISTS "shell_env" jsonb;
--> statement-breakpoint
ALTER TABLE "connection_providers" ADD COLUMN IF NOT EXISTS "note" text;
--> statement-breakpoint
ALTER TABLE "connection_providers" ADD COLUMN IF NOT EXISTS "health_check" jsonb;
--> statement-breakpoint
-- A connection's secret config fields (the provider's `format: "secret"`
-- properties) move out of the plain `config` jsonb into an AES-256-GCM blob
-- (AAD `connection|<id>`), like model-provider credentials. SQL can't
-- encrypt, so the API moves existing plaintext values at boot
-- (`sealPlaintextConnectionSecrets`).
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "secret_config" bytea;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "secret_config_iv" bytea;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "secret_config_auth_tag" bytea;
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "export_shell_env" boolean DEFAULT true NOT NULL;
