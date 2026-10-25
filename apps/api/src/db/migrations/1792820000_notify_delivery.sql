-- Notifications, finished (docs/notifications.md): a delivery queue that
-- retries with backoff and keeps what it couldn't deliver (a dead letter a
-- deployment admin retries or discards), a person's own Mattermost or Teams
-- hook, a team's channel set by its admins, and the daily digest. Additive:
-- two new tables and two nullable columns.

-- Every email and chat post Optio has yet to deliver, while the API's
-- delivery queue (BullMQ, `notify-outbox`) works on it: deleted once
-- delivered; `dead` when its retries ran out or the far end refused it for
-- good. `payload` holds the rendered email, or the chat message to render
-- for the hook in effect when it is sent (never a hook's URL).
CREATE TABLE IF NOT EXISTS "notify_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "channel" text NOT NULL,
  "kind" text NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "team_id" uuid REFERENCES "teams"("id") ON DELETE CASCADE,
  "workspace_id" uuid,
  "summary" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "dead_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "notify_outbox_status_idx" ON "notify_outbox" ("status", "updated_at");

-- A Mattermost or Teams incoming webhook: a person's own (owner_team_id
-- null) or a team's channel (owner_team_id set; owner_user_id keeps who set
-- it, as every team row does). The URL is a credential: sealed (AES-256-GCM,
-- AAD `notify_chat_hook|<id>`), shown only as `url_hint`. `events` lists the
-- kinds a team channel posts (null = the defaults).
CREATE TABLE IF NOT EXISTS "notify_chat_hooks" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid,
  "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "owner_team_id" uuid REFERENCES "teams"("id") ON DELETE CASCADE,
  "format" text NOT NULL,
  "encrypted_url" bytea NOT NULL,
  "url_iv" bytea NOT NULL,
  "url_auth_tag" bytea NOT NULL,
  "url_hint" text NOT NULL,
  "events" jsonb,
  "enabled" boolean NOT NULL DEFAULT true,
  "last_sent_at" timestamptz,
  "last_error" text,
  "last_error_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "notify_chat_hooks_person_key"
  ON "notify_chat_hooks" ("owner_user_id") WHERE "owner_team_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "notify_chat_hooks_team_key"
  ON "notify_chat_hooks" ("owner_team_id") WHERE "owner_team_id" IS NOT NULL;

-- The daily digest: the local day the person's last digest was for (one a
-- day, claimed atomically across API instances) and when it was sent (the
-- next one covers what happened since).
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "digest_sent_on" text;
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "digest_sent_at" timestamptz;
