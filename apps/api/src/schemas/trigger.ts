/**
 * Zod schemas for triggers — the same body whatever the trigger targets
 * (`/api/jobs/:id/triggers`, `/api/tasks/:id/triggers`,
 * `/api/task-configs/:id/triggers`, `/api/local/blueprints/:id/triggers`,
 * `/api/agents/:id/triggers`).
 */
import { z } from "zod";
import type { FastifyReply } from "fastify";
import { TRIGGER_TYPES } from "@optio/shared";

export const TriggerTypeEnum = z
  .enum(TRIGGER_TYPES as [string, ...string[]])
  .describe(
    "What starts the target: `manual`, `schedule` (cron), `webhook` (a path under /api/hooks), " +
      "`ticket` (ticket sync), or a `github` / `gitlab` / `slack` / `linear` / `jira` / `pylon` / " +
      "`pagerduty` / `sentry` / `alertmanager` / `datadog` event",
  );

export const TriggerConfigSchema = z
  .record(z.unknown())
  .default({})
  .describe(
    "Type-specific config: `{ cronExpression }`, `{ path, secret? }`, `{ source, labels? }`, " +
      "`{ events?, login?, repos?, branches?, workflows?, labels? }` (GitHub), " +
      "`{ events?, username?, projects?, branches?, labels? }` (GitLab), " +
      "`{ channelId, keyword?, mentionOnly?, includeThreads?, postedBy?: people|bots|anyone, bot? }` (Slack), " +
      "`{ events?, user?, labels?, teams? }` (Linear), " +
      "`{ events?, user?, projects?, labels?, issueTypes?, statuses? }` (Jira), " +
      "`{ events?: string[] }` (Pylon), `{ events?, services?, urgency?: high|low }` (PagerDuty), " +
      "`{ events?, projects?, environments?, levels? }` (Sentry), " +
      "`{ events?, alertnames?, severities?, receivers? }` (Alertmanager / Grafana), " +
      "`{ events?, priorities?, tags?, monitors? }` (Datadog). A Pylon / Alertmanager / Datadog trigger's shared " +
      "`secret` is generated on create, returned once, and shown as `hasSecret` afterwards",
  );

export const CreateTriggerBodySchema = z
  .object({
    type: TriggerTypeEnum,
    config: TriggerConfigSchema,
    paramMapping: z
      .record(z.unknown())
      .optional()
      .describe("Webhook triggers: how to map the payload to prompt params"),
    enabled: z.boolean().optional(),
  })
  .describe("Body for attaching a trigger");

export const UpdateTriggerBodySchema = z
  .object({
    config: z.record(z.unknown()).optional(),
    paramMapping: z.record(z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .describe("Partial update to a trigger");

/** Map a trigger-service error to its HTTP reply; false when it isn't one. */
export function replyTriggerError(
  reply: FastifyReply,
  err: unknown,
  input: { type?: string; config?: Record<string, unknown> },
): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === "unsupported_type") {
    reply
      .status(400)
      .send({ error: `This kind of definition can't take a "${input.type}" trigger` });
    return true;
  }
  if (msg === "duplicate_webhook_path") {
    const path = typeof input.config?.path === "string" ? ` "${input.config.path}"` : "";
    reply.status(409).send({ error: `Webhook path${path} is already in use` });
    return true;
  }
  return false;
}
