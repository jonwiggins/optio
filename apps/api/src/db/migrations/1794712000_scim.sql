-- SCIM provisioning: original split 21, four additive tables.
-- The bearer tokens an identity provider pushes SCIM changes with: SHA-256
-- of the token, and its first characters to tell tokens apart.
CREATE TABLE IF NOT EXISTS "scim_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "prefix" text NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  "revoked_at" timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "scim_tokens_hash_key" ON "scim_tokens" ("token_hash");

-- An account as SCIM provisioned it (its SCIM id is users.id).
CREATE TABLE IF NOT EXISTS "scim_users" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "external_id" text,
  "user_name" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "scim_users_user_name_key" ON "scim_users" (lower("user_name"));

-- The groups SCIM pushed and their members: a member's groups are the
-- groups' display names, applied like a sign-in's.
CREATE TABLE IF NOT EXISTS "scim_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "display_name" text NOT NULL,
  "external_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "scim_group_members" (
  "group_id" uuid NOT NULL REFERENCES "scim_groups"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  PRIMARY KEY ("group_id", "user_id")
);
CREATE INDEX IF NOT EXISTS "scim_group_members_user_idx" ON "scim_group_members" ("user_id");
