-- Credential health (docs/credential-health.md): what the credential-health
-- worker last found about each token Optio holds — the organization's, a
-- team's and each person's GitLab tokens, gateway tokens, Jira connections
-- and Coder connections — and which warnings it already sent about it.
-- Additive: one new table.
--
-- One row per credential, keyed by what it is rather than by its value
-- (`gitlab:user:<id>`, `gateway:<provider>:team:<id>`, `jira:<provider>`…),
-- so a replaced token keeps its row and its history. `scope` says whose it
-- is: `organization` (user_id and team_id null), `team` (team_id) or
-- `person` (user_id). These are not resources people own: the row is
-- derived from the secret or connection it names, and the route shows it
-- by `scope` (services/credential-health/store.ts).
CREATE TABLE IF NOT EXISTS "credential_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "credential_key" text NOT NULL,
  "kind" text NOT NULL,
  "label" text NOT NULL,
  "scope" text NOT NULL,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "team_id" uuid REFERENCES "teams"("id") ON DELETE CASCADE,
  -- ok | warning | error | unknown (couldn't tell: the service was unreachable)
  "status" text NOT NULL DEFAULT 'unknown',
  "reason" text,
  "expires_at" timestamptz,
  -- What the check read: host, scopes, spend / max budget / reset, account.
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The warnings sent, marker → ISO time (`expiry:7:2026-11-01`, `invalid`,
  -- `budget:<reset>`), so each goes out once per threshold per credential.
  "notified" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "checked_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "credential_checks_key_unique" UNIQUE ("credential_key")
);

CREATE INDEX IF NOT EXISTS "credential_checks_user_idx" ON "credential_checks" ("user_id");
CREATE INDEX IF NOT EXISTS "credential_checks_team_idx" ON "credential_checks" ("team_id");
CREATE INDEX IF NOT EXISTS "credential_checks_workspace_idx" ON "credential_checks" ("workspace_id");
