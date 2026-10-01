-- Every PR a Repo Task opened or tracks. tasks.pr_url stays the primary one
-- (what the PR lifecycle follows); a task that opens several PRs records the
-- rest here. Backfilled with each task's existing primary PR.
CREATE TABLE IF NOT EXISTS "task_prs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
	"repo_url" text NOT NULL,
	"number" integer NOT NULL,
	"url" text NOT NULL,
	"head_branch" text,
	"head_repo" text,
	"base_branch" text,
	"source" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_prs_task_url_idx" ON "task_prs" USING btree ("task_id","url");
--> statement-breakpoint
INSERT INTO "task_prs" ("task_id", "repo_url", "number", "url", "source", "state", "created_at", "updated_at")
SELECT
	t."id",
	t."repo_url",
	COALESCE(t."pr_number", (substring(t."pr_url" from '(\d+)/?$'))::integer, 0),
	t."pr_url",
	'branch',
	CASE WHEN t."pr_state" = 'merged' THEN 'merged' WHEN t."pr_state" = 'closed' THEN 'closed' ELSE 'open' END,
	t."created_at",
	t."updated_at"
FROM "tasks" t
WHERE t."pr_url" IS NOT NULL
ON CONFLICT DO NOTHING;
