-- Persistent Agents — long-lived, named, message-driven agent processes.
--
-- Distinct from Tasks (Repo Tasks and Standalone Tasks): a Persistent Agent
-- does not terminate after running. It executes a turn, halts, and waits to be
-- re-woken by a user message, an agent message, a webhook, a cron tick, or a
-- ticket event. State machine is cyclic.
--
-- See docs/persistent-agents.md for design rationale.

DO $$ BEGIN
  CREATE TYPE "persistent_agent_state" AS ENUM(
    'idle', 'queued', 'provisioning', 'running', 'paused', 'failed', 'archived'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "persistent_agent_pod_lifecycle" AS ENUM(
    'always-on', 'sticky', 'on-demand'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "persistent_agent_turn_halt_reason" AS ENUM(
    'natural', 'wait_tool', 'max_duration', 'max_turns', 'error', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "persistent_agent_message_sender_type" AS ENUM(
    'user', 'agent', 'system', 'external'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE "persistent_agents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "agent_runtime" text NOT NULL DEFAULT 'claude-code',
  "model" text,
  "system_prompt" text,
  "agents_md" text,
  "initial_prompt" text NOT NULL,
  "prompt_template_id" uuid REFERENCES "prompt_templates"("id"),
  "repo_id" uuid REFERENCES "repos"("id") ON DELETE SET NULL,
  "branch" text,
  "worktree_path" text,
  "pod_lifecycle" "persistent_agent_pod_lifecycle" NOT NULL DEFAULT 'sticky',
  "idle_pod_timeout_ms" integer NOT NULL DEFAULT 300000,
  "sticky_pod_id" uuid,
  "max_turn_duration_ms" integer NOT NULL DEFAULT 600000,
  "max_turns" integer NOT NULL DEFAULT 50,
  "consecutive_failure_limit" integer NOT NULL DEFAULT 3,
  "state" "persistent_agent_state" NOT NULL DEFAULT 'idle',
  "enabled" boolean NOT NULL DEFAULT true,
  "total_cost_usd" text NOT NULL DEFAULT '0',
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "last_failure_at" timestamptz,
  "last_failure_reason" text,
  "last_turn_at" timestamptz,
  "session_id" text,
  "control_intent" text,
  "reconcile_backoff_until" timestamptz,
  "reconcile_attempts" integer NOT NULL DEFAULT 0,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT "persistent_agents_workspace_slug_key" UNIQUE ("workspace_id", "slug")
);

CREATE INDEX "persistent_agents_workspace_id_idx" ON "persistent_agents" ("workspace_id");
CREATE INDEX "persistent_agents_state_idx" ON "persistent_agents" ("state");
CREATE INDEX "persistent_agents_repo_id_idx" ON "persistent_agents" ("repo_id");

CREATE TABLE "persistent_agent_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "persistent_agents"("id") ON DELETE CASCADE,
  "turn_number" integer NOT NULL,
  "wake_source" text NOT NULL,
  "wake_payload" jsonb,
  "prompt_used" text,
  "pod_id" uuid,
  "pod_name" text,
  "halt_reason" "persistent_agent_turn_halt_reason",
  "error_message" text,
  "cost_usd" text,
  "input_tokens" integer,
  "output_tokens" integer,
  "session_id" text,
  "summary" text,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT "persistent_agent_turns_agent_turn_key" UNIQUE ("agent_id", "turn_number")
);

CREATE INDEX "persistent_agent_turns_agent_id_idx" ON "persistent_agent_turns" ("agent_id");

CREATE TABLE "persistent_agent_turn_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "turn_id" uuid NOT NULL REFERENCES "persistent_agent_turns"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "persistent_agents"("id") ON DELETE CASCADE,
  "stream" text NOT NULL DEFAULT 'stdout',
  "content" text NOT NULL,
  "log_type" text,
  "metadata" jsonb,
  "timestamp" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX "persistent_agent_turn_logs_turn_idx"
  ON "persistent_agent_turn_logs" ("turn_id", "timestamp");
CREATE INDEX "persistent_agent_turn_logs_agent_idx"
  ON "persistent_agent_turn_logs" ("agent_id", "timestamp");

CREATE TABLE "persistent_agent_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "persistent_agents"("id") ON DELETE CASCADE,
  "sender_type" "persistent_agent_message_sender_type" NOT NULL,
  "sender_id" text,
  "sender_name" text,
  "body" text NOT NULL,
  "structured_payload" jsonb,
  "broadcasted" boolean NOT NULL DEFAULT false,
  "received_at" timestamptz NOT NULL DEFAULT NOW(),
  "processed_at" timestamptz,
  "turn_id" uuid REFERENCES "persistent_agent_turns"("id") ON DELETE SET NULL
);

CREATE INDEX "persistent_agent_messages_inbox_idx"
  ON "persistent_agent_messages" ("agent_id", "processed_at");
CREATE INDEX "persistent_agent_messages_received_idx"
  ON "persistent_agent_messages" ("agent_id", "received_at");
CREATE INDEX "persistent_agent_messages_turn_idx"
  ON "persistent_agent_messages" ("turn_id");

CREATE TABLE "persistent_agent_pods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "persistent_agents"("id") ON DELETE CASCADE,
  "workspace_id" uuid,
  "pod_name" text,
  "pod_id" text,
  "state" "workflow_pod_state" NOT NULL DEFAULT 'provisioning',
  "last_turn_at" timestamptz,
  "keep_warm_until" timestamptz,
  "error_message" text,
  "job_name" text,
  "managed_by" text NOT NULL DEFAULT 'bare-pod',
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX "persistent_agent_pods_agent_idx" ON "persistent_agent_pods" ("agent_id");
CREATE INDEX "persistent_agent_pods_workspace_idx" ON "persistent_agent_pods" ("workspace_id");
CREATE INDEX "persistent_agent_pods_keep_warm_idx" ON "persistent_agent_pods" ("keep_warm_until");
