-- Credential health (docs/credential-health.md): what the last check found
-- about each token Optio holds (the organization's and each person's GitLab
-- tokens, each gateway's tokens) and which warnings it already sent about
-- it. Additive: one new table.
--
-- One row per credential, keyed by what it is rather than by its value
-- (`gitlab:GITLAB_TOKEN:user:<id>`, `gateway:<provider>:user:<id>`), so a
-- replaced token keeps its row. `scope` says whose it is: `organization`
-- (user_id null) or `person` (user_id). Nothing here holds a token.
CREATE TABLE IF NOT EXISTS "credential_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "credential_key" text NOT NULL,
  "kind" text NOT NULL,
  "label" text NOT NULL,
  "scope" text NOT NULL,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  -- ok | warning | error | unknown (couldn't tell: the service was unreachable)
  "status" text NOT NULL DEFAULT 'unknown',
  "reason" text,
  "expires_at" timestamptz,
  -- What the check read: host, scopes, spend / budget / reset. Never a token.
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The warnings sent, marker -> ISO time (`expiry:7:2026-11-01`, `invalid`,
  -- `budget:<reset>`), so each goes out once per threshold per credential.
  "notified" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "checked_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "credential_checks_key_unique" UNIQUE ("credential_key"),
  CONSTRAINT "credential_checks_scope_check" CHECK ("scope" IN ('person', 'organization')),
  CONSTRAINT "credential_checks_status_check" CHECK ("status" IN ('ok', 'warning', 'error', 'unknown'))
);

CREATE INDEX IF NOT EXISTS "credential_checks_user_idx" ON "credential_checks" ("user_id");
CREATE INDEX IF NOT EXISTS "credential_checks_workspace_idx" ON "credential_checks" ("workspace_id");
