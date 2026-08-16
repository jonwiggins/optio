-- Scope the Optio action audit trail to a workspace.
--
-- The unified activity feed (GET /api/activity) previously returned every
-- tenant's actions to any authenticated user, and the logged `params` jsonb
-- could carry other tenants' resource ids (and, before the write-time
-- allowlist, request-body values). Actions are now stamped with the caller's
-- workspace so the feed can filter by tenant.
--
-- Existing rows keep workspace_id = NULL. NULL is treated as an
-- operator/legacy action with no tenant context and is only surfaced to
-- admins by the activity feed (deny-by-default) — never to members/viewers.

ALTER TABLE "optio_actions" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
CREATE INDEX "optio_actions_workspace_id_idx" ON "optio_actions" ("workspace_id");
