ALTER TABLE "repos" ADD COLUMN "review_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "review_trigger" text DEFAULT 'on_ci_pass';--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "review_prompt_template" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "test_command" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "review_model" text DEFAULT 'sonnet';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "parent_task_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "task_type" text DEFAULT 'coding' NOT NULL;