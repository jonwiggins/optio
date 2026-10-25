/**
 * Whose an outbound-webhook event's work is, and where — what
 * services/webhook-audience.ts decides its audience by. Kept apart (no
 * imports) so the services that emit events can build it without loading
 * the audience's lookups.
 */
/** Whose an event's work is, and where (`workOwnerFields` in task-service.ts). */
export interface WebhookScope {
  workspaceId: string | null;
  ownerUserId: string | null;
  ownerTeamId: string | null;
  createdBy: string | null;
}

/** The scope fields of a work row (a task, a Job): what an event about it carries. */
export function webhookScopeOf(row: {
  workspaceId?: string | null;
  ownerUserId?: string | null;
  ownerTeamId?: string | null;
  createdBy?: string | null;
}): WebhookScope {
  return {
    workspaceId: row.workspaceId ?? null,
    ownerUserId: row.ownerUserId ?? null,
    ownerTeamId: row.ownerTeamId ?? null,
    createdBy: row.createdBy ?? null,
  };
}

/**
 * Where an event's scope rides on its data: a symbol key, so it never
 * reaches a payload (JSON drops it) and an emitter adds it with one line —
 * `...webhookScope(workOwnerFields(task))` — inside the data it already
 * builds. `enqueueWebhookEvent` reads it (workers/webhook-worker.ts).
 */
export const WEBHOOK_SCOPE: unique symbol = Symbol("optio.webhookScope");

/** `{ [WEBHOOK_SCOPE]: scope }`, to spread into an event's data. */
export function webhookScope(row: Parameters<typeof webhookScopeOf>[0]): {
  [WEBHOOK_SCOPE]: WebhookScope;
} {
  return { [WEBHOOK_SCOPE]: webhookScopeOf(row) };
}

/** The scope an event's data carries, if any. */
export function scopeOfEventData(data: object): WebhookScope | undefined {
  return (data as { [WEBHOOK_SCOPE]?: WebhookScope })[WEBHOOK_SCOPE];
}
