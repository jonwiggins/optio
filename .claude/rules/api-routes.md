# API Routes and Workers

## Key routes beyond basic CRUD

- `POST /api/tasks/reorder` -- reorder task priorities by position
- `POST /api/tasks/bulk/retry-failed` -- retry all failed tasks
- `POST /api/tasks/bulk/cancel-active` -- cancel all running + queued tasks
- `POST /api/tasks/:id/review` -- manually launch a review agent for a task
- `POST /api/tasks/:id/resume` -- resume a needs_attention/failed task (session-based)
- `POST /api/tasks/:id/force-restart` -- fresh agent session on existing PR branch
- `POST /api/tasks/:id/force-redo` -- clear everything and re-run from scratch
- `POST /api/tasks/:id/subtasks` -- create a subtask (child, step, or review)
- `POST /api/tasks/:id/comments` -- add a comment to a task
- `GET /api/sessions` / `POST /api/sessions` -- interactive session management
- `GET /api/issues` -- browse GitHub Issues across all repos
- `POST /api/issues/assign` -- assign a GitHub Issue to Optio
- `GET /api/auth/providers` -- list enabled OAuth providers
- `GET /api/auth/me` -- current user profile
- `GET /api/auth/status` -- Claude subscription status (checks Keychain + secrets store)
- `GET /api/auth/usage` -- Claude Max/Pro usage metrics
- `GET /api/analytics/costs` -- cost analytics with daily/repo/type breakdowns
- `POST /api/webhooks/slack/actions` -- handle Slack interactive button clicks (retry, cancel)
- `POST /api/slack/test` -- test Slack webhook configuration
- `GET /api/slack/status` -- check global Slack webhook status
- `GET/POST /api/workspaces` -- list/create workspaces
- `GET/PATCH/DELETE /api/workspaces/:id` -- workspace CRUD
- `POST /api/workspaces/:id/switch` -- switch active workspace
- `GET/POST /api/workspaces/:id/members` -- list/add workspace members
- `PATCH/DELETE /api/workspaces/:id/members/:userId` -- update role/remove member
- `GET /api/webhooks` -- webhook configuration
- `GET /api/schedules` -- scheduled/recurring task management
- `GET /api/mcp-servers` -- MCP server configuration
- `GET /api/skills` -- custom skill management

## Workers

Six BullMQ workers run as part of the API server:

1. **task-worker** -- main job processor, handles concurrency, dependency checks, provisioning, agent execution, result parsing
2. **pr-watcher-worker** -- polls GitHub PRs every 30s, tracks CI/review status, triggers reviews, auto-resumes on conflicts/failures, handles merge/close
3. **repo-cleanup-worker** -- health checks every 60s, auto-restart crashed pods, clean orphan worktrees, idle cleanup
4. **ticket-sync-worker** -- syncs tickets from configured providers (GitHub Issues, Linear)
5. **webhook-worker** -- delivers webhook events to configured endpoints
6. **schedule-worker** -- checks and triggers scheduled/recurring tasks
