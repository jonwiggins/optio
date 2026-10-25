-- More sign-in options (docs/sign-in.md, docs/directory-sync.md): the other
-- provider identities of an account, and SCIM 2.0 provisioning. Additive:
-- five new tables, nothing changed on an existing one.

-- Another provider identity of an account: a sign-in linked to an existing
-- account by email (only with OPTIO_LINK_ACCOUNTS_BY_EMAIL=true), or one that
-- claimed an account SCIM provisioned. users.provider / users.external_id
-- keep the identity the account was created with.
CREATE TABLE IF NOT EXISTS "user_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "external_id" text NOT NULL,
  "email" text,
  "linked_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_identities_provider_external_key"
  ON "user_identities" ("provider", "external_id");
CREATE INDEX IF NOT EXISTS "user_identities_user_idx" ON "user_identities" ("user_id");

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
