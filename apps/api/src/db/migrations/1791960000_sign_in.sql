-- Sign-in configured in the app (docs/plans/org-scoping-and-sso.md, "Sign-in").
--
-- `auth_provider_configs`: one row per OAuth provider configured from Settings
-- → Sign-in (today: google). The client secret is AES-256-GCM encrypted on
-- the row (AAD `auth_provider|<provider>`), like model-provider credentials —
-- not in `secrets`, which reach repo pods and are writable by any workspace
-- admin. A stored, enabled row takes precedence over the provider's env vars.
-- `allowed_domains` restricts who may sign in with it (Google Workspace `hd`
-- and the verified email's domain); empty = anyone the provider vouches for.
CREATE TABLE IF NOT EXISTS "auth_provider_configs" (
  "provider" text PRIMARY KEY,
  "client_id" text NOT NULL,
  "encrypted_client_secret" bytea,
  "client_secret_iv" bytea,
  "client_secret_auth_tag" bytea,
  "allowed_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "display_name" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Deployment admins may change how everyone signs in. Separate from workspace
-- roles: every signer-in becomes admin of a workspace of their own, so
-- "workspace admin" can't guard instance-wide settings.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deployment_admin" boolean DEFAULT false NOT NULL;
