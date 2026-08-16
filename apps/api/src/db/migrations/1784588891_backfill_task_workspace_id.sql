-- Backfill: stamp workspace_id on tasks that were created without one.
--
-- Tasks created by non-interactive paths (GitHub webhook / ticket-sync
-- polling, and review/child subtasks) were inserted with workspace_id =
-- NULL, so the workspace-scoped UI queries filtered them out even though
-- they ran fine (issue #544). The application layer now inherits the
-- workspace from the repo (ticket sync), the parent task (subtasks), or
-- the task_config; this migration repairs existing rows.
--
-- A row is only updated when its repo_url maps to exactly one non-NULL
-- workspace across the repos table — ambiguous URLs (same repo configured
-- in multiple workspaces) are left untouched rather than guessed at.

UPDATE tasks t
   SET workspace_id = r.workspace_id
  FROM repos r
 WHERE t.workspace_id IS NULL
   AND r.repo_url = t.repo_url
   AND r.workspace_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM repos r2
      WHERE r2.repo_url = t.repo_url
        AND r2.workspace_id IS NOT NULL
        AND r2.workspace_id <> r.workspace_id
   );
