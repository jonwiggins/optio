-- Do not relabel old pods: their homes and caches may hold another owner's credentials.
ALTER TABLE "agent_pods" ADD COLUMN "isolation_key" text;
DROP INDEX IF EXISTS "agent_pods_standalone_instance_key";
CREATE UNIQUE INDEX "agent_pods_isolated_instance_key"
  ON "agent_pods" ("pool", "pool_key", "isolation_key", "instance_index")
  WHERE "isolation_key" IS NOT NULL;

CREATE TABLE "session_shares" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "kind" text NOT NULL CHECK (kind IN ('pod', 'local')),
  "target_id" uuid NOT NULL, "owner_user_id" uuid NOT NULL, "workspace_id" uuid NOT NULL,
  "token_hash" text NOT NULL UNIQUE, "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz, "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "session_shares_target_idx" ON "session_shares" ("kind", "target_id");
CREATE TABLE "session_share_members" (
  "share_id" uuid NOT NULL REFERENCES "session_shares" ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users" ON DELETE CASCADE,
  "joined_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "session_share_members_key" ON "session_share_members" ("share_id", "user_id");

CREATE TABLE "session_chat_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL REFERENCES "interactive_sessions" ON DELETE CASCADE,
  "request_id" uuid NOT NULL, "prompt_hash" text NOT NULL,
  "state" text NOT NULL CHECK (state IN ('running', 'completed', 'interrupted')),
  "started_at" timestamptz NOT NULL DEFAULT now(), "finished_at" timestamptz
);
CREATE UNIQUE INDEX "session_chat_turns_request_key" ON "session_chat_turns" ("session_id", "request_id");
CREATE UNIQUE INDEX "session_chat_turns_running_key" ON "session_chat_turns" ("session_id") WHERE "state" = 'running';

ALTER TABLE "tasks" ADD COLUMN "recovery_required" boolean NOT NULL DEFAULT false;
