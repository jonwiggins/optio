/**
 * Who may change, test or delete an outbound webhook and read its
 * deliveries — the server's rule (`webhookRefusal` in
 * apps/api/src/services/webhook-audience.ts), so the pages offer only what
 * will work: its creator or a workspace admin; for a hook with no workspace
 * (made before workspaces), a deployment admin only. Everyone, with auth
 * disabled.
 */
export interface WebhookOwner {
  workspaceId?: string | null;
  createdBy?: string | null;
}

export interface WebhookViewer {
  authDisabled: boolean;
  userId: string | null;
  isAdmin: boolean;
  isDeploymentAdmin: boolean;
}

export function mayManageWebhook(hook: WebhookOwner, viewer: WebhookViewer): boolean {
  if (viewer.authDisabled) return true;
  if (!hook.workspaceId) return viewer.isDeploymentAdmin;
  if (viewer.userId && hook.createdBy === viewer.userId) return true;
  return viewer.isAdmin;
}

/** Whether a failed request was the server refusing (403), not an outage. */
export function isRefusal(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 403;
}
