/**
 * Who holds the deployment-admin role, as pure rules over a `users` row and
 * the environment — shared by `sign-in-config-service.ts` (deployment-wide
 * settings) and `workspace-service.ts` (the role in a workspace), which can't
 * import each other. No database access here.
 */

/** The parts of a `users` row the rule reads. */
export interface DeploymentAdminRow {
  deploymentAdmin: boolean;
  email: string;
  emailVerified: boolean;
}

/**
 * Emails granted the role by the environment (`OPTIO_DEPLOYMENT_ADMINS`,
 * comma-separated). The list is the grant itself, read on every check and
 * never stored on the account: an email taken off it stops being a
 * deployment admin.
 */
export function envDeploymentAdmins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.OPTIO_DEPLOYMENT_ADMINS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Whether this account is a deployment admin: granted in the app
 * (`users.deployment_admin`), or by `OPTIO_DEPLOYMENT_ADMINS` for an email
 * its sign-in provider verified.
 */
export function holdsDeploymentAdmin(
  row: DeploymentAdminRow,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    row.deploymentAdmin ||
    (row.emailVerified && envDeploymentAdmins(env).has(row.email.toLowerCase()))
  );
}

/**
 * Whether deployment admins are also admins of every workspace — the ones
 * they belong to and the ones they don't (`OPTIO_DEPLOYMENT_ADMINS_ALL_WORKSPACES`,
 * Helm `auth.deploymentAdminsAllWorkspaces`). Off unless the environment says
 * true. Set by whoever deploys Optio and never in the app, so the people it
 * empowers can't turn it on for themselves; read on every check, so turning it
 * off (and restarting) takes the access away.
 */
export function deploymentAdminsAdministerAllWorkspaces(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.OPTIO_DEPLOYMENT_ADMINS_ALL_WORKSPACES ?? "").trim().toLowerCase();
  return ["true", "1", "yes", "on"].includes(raw);
}
