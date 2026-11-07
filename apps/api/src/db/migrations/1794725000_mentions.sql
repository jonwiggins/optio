-- @-mentions of Optio's bot in GitHub and GitLab comments (services/gitlab-bot/,
-- docs/gitlab-bot.md; off by default). One row per comment that mentions the bot on a
-- project Optio knows: what Optio made of it (ignored, refused, started or
-- resumed work), who it ran as, and the run, so the run's result goes back
-- to the comment's thread when it ends. A comment is handled once, however
-- many hooks deliver it (unique host + note id). Additive: one new table.
CREATE TABLE IF NOT EXISTS "gitlab_mentions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The GitLab host (`gitlab.example.test`) and GitLab's own ids.
  "host" text NOT NULL,
  "note_id" bigint NOT NULL,
  "delivery_uuid" text,
  "project_id" bigint NOT NULL,
  "project_url" text NOT NULL,
  -- MergeRequest | Issue, and its iid.
  "noteable_type" text NOT NULL,
  "noteable_iid" integer NOT NULL,
  "discussion_id" text,
  "note_url" text,
  "author_gitlab_id" bigint,
  "author_username" text NOT NULL,
  -- The comment (cut to 20 000 characters) and the merge request's or
  -- issue's fields the command needs (branches, state, title, description).
  "note" text NOT NULL,
  "subject" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- What Optio decided.
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "command" text,
  -- received | processing | ignored | refused | rate_limited | started | done | failed
  "status" text NOT NULL DEFAULT 'received',
  "reason" text,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "replied_at" timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "gitlab_mentions_note_key" ON "gitlab_mentions" ("host", "note_id");
-- The rate limit: commands on one merge request or issue lately.
CREATE INDEX IF NOT EXISTS "gitlab_mentions_subject_idx"
  ON "gitlab_mentions" ("host", "project_id", "noteable_type", "noteable_iid", "created_at");
-- A run's open commands, when the run ends.
CREATE INDEX IF NOT EXISTS "gitlab_mentions_task_idx" ON "gitlab_mentions" ("task_id")
  WHERE "status" = 'started';
-- Rows left waiting (an instance that stopped midway) and the prune.
CREATE INDEX IF NOT EXISTS "gitlab_mentions_status_idx" ON "gitlab_mentions" ("status", "created_at");
