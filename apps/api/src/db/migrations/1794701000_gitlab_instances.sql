-- Additive: admin-managed GitLab instances with encrypted default tokens.
CREATE TABLE IF NOT EXISTS "gitlab_instances" (
  "id" uuid PRIMARY KEY,
  "base_url" text NOT NULL DEFAULT '',
  "display_name" text NOT NULL DEFAULT '',
  "ca_pem" text,
  "encrypted_token" bytea,
  "token_iv" bytea,
  "token_auth_tag" bytea,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "gitlab_instances_base_url_unique" UNIQUE ("base_url")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gitlab_instances_host_unique" ON "gitlab_instances"
  ((split_part(split_part("base_url", '://', 2), '/', 1)));
