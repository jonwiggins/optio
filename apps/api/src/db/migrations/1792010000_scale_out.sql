-- Scale-out (docs/plans/scale-out.md): every API pod shares one database, and
-- a run outlives the pod that started it. This migration carries every schema
-- change of the plan, so the phases that follow (re-attachable runs,
-- coordination, sessions / glance / skills) touch no schema.

-- Runs: which instance is streaming the run, until when, how much of the
-- pod-side output file it has turned into log rows, and the supervisor the
-- agent runs under in its pod (run-protocol.ts). On `tasks` (every repo task
-- and Job run; the run views follow on their own), PR-review runs, and
-- persistent-agent turns.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "exec_state" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "exec_pid" integer;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "consumed_bytes" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "attached_by" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "attach_lease_until" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_attach_lease_idx" ON "tasks" ("attach_lease_until")
  WHERE "exec_state" = 'started';
--> statement-breakpoint
ALTER TABLE "pr_review_runs" ADD COLUMN IF NOT EXISTS "exec_state" text;
--> statement-breakpoint
ALTER TABLE "pr_review_runs" ADD COLUMN IF NOT EXISTS "exec_pid" integer;
--> statement-breakpoint
ALTER TABLE "pr_review_runs" ADD COLUMN IF NOT EXISTS "consumed_bytes" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "pr_review_runs" ADD COLUMN IF NOT EXISTS "attached_by" text;
--> statement-breakpoint
ALTER TABLE "pr_review_runs" ADD COLUMN IF NOT EXISTS "attach_lease_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "persistent_agent_turns" ADD COLUMN IF NOT EXISTS "exec_state" text;
--> statement-breakpoint
ALTER TABLE "persistent_agent_turns" ADD COLUMN IF NOT EXISTS "exec_pid" integer;
--> statement-breakpoint
ALTER TABLE "persistent_agent_turns" ADD COLUMN IF NOT EXISTS "consumed_bytes" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "persistent_agent_turns" ADD COLUMN IF NOT EXISTS "attached_by" text;
--> statement-breakpoint
ALTER TABLE "persistent_agent_turns" ADD COLUMN IF NOT EXISTS "attach_lease_until" timestamp with time zone;
--> statement-breakpoint

-- Leases: the one way an instance claims something for a while (a poller's
-- turn, a chat lock, a Local host). services/lease-service.ts.
CREATE TABLE IF NOT EXISTS "leases" (
  "key" text PRIMARY KEY,
  "holder" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint

-- Single-use WebSocket upgrade tokens, minted by one instance and consumed
-- by whichever one the browser's upgrade lands on.
CREATE TABLE IF NOT EXISTS "ws_upgrade_tokens" (
  "token_hash" text PRIMARY KEY,
  "user_id" uuid NOT NULL,
  "workspace_id" uuid,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ws_upgrade_tokens_expires_idx" ON "ws_upgrade_tokens" ("expires_at");
--> statement-breakpoint

-- Inbound webhook deliveries already handled, by source and the provider's
-- delivery id: a claim is an insert that returns a row. Swept after a day.
-- (`webhook_deliveries` is the outbound webhooks' delivery log.)
CREATE TABLE IF NOT EXISTS "inbound_webhook_deliveries" (
  "source" text NOT NULL,
  "delivery_id" text NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("source", "delivery_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_webhook_deliveries_received_idx" ON "inbound_webhook_deliveries" ("received_at");
--> statement-breakpoint

-- The glance / push bookkeeping that lived in one process's memory: one row
-- per key (`attention:<terminal>`, `needs-you:<user>`, `running:<user>`,
-- `host-offline:<host>`), and timers as rows with a due time
-- (`watch-end:<user>`, `snooze:<terminal>`), swept when due.
CREATE TABLE IF NOT EXISTS "glance_state" (
  "key" text PRIMARY KEY,
  "value" jsonb NOT NULL,
  "due_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "glance_state_due_idx" ON "glance_state" ("due_at") WHERE "due_at" IS NOT NULL;
--> statement-breakpoint

-- Marketplace skills' files, written by the sync worker and read at spawn,
-- so a skill is there on every instance (the cache PVC was ReadWriteOnce).
CREATE TABLE IF NOT EXISTS "installed_skill_files" (
  "skill_id" uuid NOT NULL REFERENCES "installed_skills"("id") ON DELETE CASCADE,
  "path" text NOT NULL,
  "content" bytea NOT NULL,
  "executable" boolean DEFAULT false NOT NULL,
  "resolved_sha" text,
  PRIMARY KEY ("skill_id", "path")
);
--> statement-breakpoint

-- The ticket sync's claim: one task per (source, ticket, repo) created by the
-- sync, however many sweeps overlap. Its own table rather than an index on
-- tasks: a person may start a second task from the same issue on purpose.
CREATE TABLE IF NOT EXISTS "ticket_sync_claims" (
  "ticket_source" text NOT NULL,
  "ticket_external_id" text NOT NULL,
  "repo_url" text NOT NULL,
  "task_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("ticket_source", "ticket_external_id", "repo_url")
);
--> statement-breakpoint

-- External PR reviews: one active review per PR URL, so two overlapping
-- sweeps can't both launch one. Older active duplicates (left by overlapping
-- sweeps before this) are cancelled first, newest kept.
UPDATE "pr_reviews" SET "state" = 'cancelled', "updated_at" = now()
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (PARTITION BY "pr_url" ORDER BY "updated_at" DESC, "created_at" DESC) AS rn
    FROM "pr_reviews" WHERE "state" IN ('queued', 'waiting_ci', 'reviewing', 'ready')
  ) d WHERE rn > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pr_reviews_active_pr_url_key" ON "pr_reviews" ("pr_url")
  WHERE "state" IN ('queued', 'waiting_ci', 'reviewing', 'ready');
