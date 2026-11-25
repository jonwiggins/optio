-- boxd joins the remote-workspace providers (docs/remote-workspaces.md): a
-- connection may be for boxd, and a machine Optio started in one says so.
ALTER TABLE "remote_workspace_connections" DROP CONSTRAINT IF EXISTS "remote_workspace_connections_provider_check";
ALTER TABLE "remote_workspace_connections" ADD CONSTRAINT "remote_workspace_connections_provider_check"
  CHECK ("provider" IN ('boxd', 'coder', 'codespaces', 'daytona', 'e2b'));

ALTER TABLE "local_hosts" DROP CONSTRAINT IF EXISTS "local_hosts_origin_check";
ALTER TABLE "local_hosts" ADD CONSTRAINT "local_hosts_origin_check"
  CHECK ("origin" IN ('machine', 'boxd', 'coder', 'codespaces', 'daytona', 'e2b'));
