/**
 * Trigger dispatch — one path from "a trigger fired" to "its target started
 * something", whatever the trigger type (schedule, webhook, ticket, GitHub /
 * Slack / Linear event) and whatever it targets:
 *
 *   job              → a workflow run
 *   task_config      → a task (the full Repo Task pipeline)
 *   local_blueprint  → a terminal on the owner's machine
 *   persistent_agent → a message in the agent's inbox (the reconciler starts a turn)
 *   pr_review        → a re-review
 *
 * The schedule poller, the webhook ingress, the ticket sweep, and the event
 * ingress all call `fireTrigger`; they only differ in how they find the
 * trigger and what they hand it. The ticket and event fan-outs live here too.
 */
import type { TriggerType } from "@optio/shared";
import { logger } from "../logger.js";
import * as workflowService from "./workflow-service.js";
import * as taskConfigService from "./task-config-service.js";
import {
  listEnabledTriggersOfType,
  markTriggerFired,
  ticketTriggerMatches,
  ticketTriggerParams,
  type TicketFiring,
  type TriggerRow,
} from "./trigger-service.js";

/** What a firing carries into the target. */
export interface TriggerFiring {
  /** The trigger type that fired — a persistent agent's wake source, a terminal's spawn reason. */
  source: Exclude<TriggerType, "manual">;
  /** `{{param}}`s for the prompt / command template. */
  params?: Record<string, unknown>;
  /** The ticket / PR / issue the firing is about, so the run links back to it. */
  ticket?: { source: string; externalId: string; url?: string };
  /** Repo the event was about — a Local automation with no pinned dir resolves its checkout from it. */
  repoUrlHint?: string;
  /** Title for the spawned run / terminal (defaults to the definition's name). */
  title?: string;
  /** Message body for a persistent agent (it reads an inbox, not params). */
  message?: string;
}

export type TriggerFireResult =
  | { kind: "workflow_run"; id: string }
  | { kind: "task"; id: string }
  | { kind: "local_terminal"; id: string }
  | { kind: "persistent_agent"; id: string }
  | { kind: "pr_review_run"; id: string };

/**
 * Start what the trigger's target starts. Returns null when the target is
 * gone or disabled (logged, not an error); throws when the spawn itself
 * fails, so a caller that answers an HTTP request can say why. On success
 * the trigger's `last_fired_at` is stamped.
 */
export async function fireTrigger(
  trigger: Pick<TriggerRow, "id" | "targetType" | "targetId">,
  firing: TriggerFiring,
): Promise<TriggerFireResult | null> {
  const result = await dispatch(trigger, firing);
  if (result) {
    await markTriggerFired(trigger.id).catch(() => {});
    logger.info(
      { triggerId: trigger.id, targetType: trigger.targetType, source: firing.source, ...result },
      "Trigger fired",
    );
  }
  return result;
}

async function dispatch(
  trigger: Pick<TriggerRow, "id" | "targetType" | "targetId">,
  firing: TriggerFiring,
): Promise<TriggerFireResult | null> {
  const skip = (what: string) => {
    logger.warn(
      { triggerId: trigger.id, targetType: trigger.targetType, targetId: trigger.targetId },
      `Trigger target ${what}, skipping`,
    );
    return null;
  };

  switch (trigger.targetType) {
    case "job": {
      const workflow = await workflowService.getWorkflow(trigger.targetId);
      if (!workflow) return skip("missing");
      if (!workflow.enabled) return skip("disabled");
      const run = await workflowService.createWorkflowRun(workflow.id, {
        triggerId: trigger.id,
        params: firing.params,
      });
      return { kind: "workflow_run", id: run.id };
    }

    case "task_config": {
      const config = await taskConfigService.getTaskConfig(trigger.targetId);
      if (!config) return skip("missing");
      if (!config.enabled) return skip("disabled");
      const task = await taskConfigService.instantiateTask(config.id, {
        triggerId: trigger.id,
        params: firing.params,
        // A ticket link closes the issue when the task completes — right for
        // a ticket trigger, wrong for a PR / issue *event* the task only
        // reacts to (its fields still reach the prompt as params).
        ticket: firing.source === "ticket" ? firing.ticket : undefined,
      });
      return { kind: "task", id: task.id };
    }

    case "local_blueprint": {
      const { getBlueprint, spawnFromBlueprint } = await import("./local-blueprint-service.js");
      const blueprint = await getBlueprint(trigger.targetId);
      if (!blueprint) return skip("missing");
      if (!blueprint.enabled) return skip("disabled");
      const terminal = await spawnFromBlueprint(blueprint, {
        triggerId: trigger.id,
        spawnedBy: firing.source === "ticket" ? "ticket" : "trigger",
        params: firing.params,
        ticket: firing.ticket,
        repoUrlHint: firing.repoUrlHint,
        title: firing.title ? `${blueprint.name} · ${firing.title}` : undefined,
      });
      return { kind: "local_terminal", id: terminal.id };
    }

    case "persistent_agent": {
      const { getPersistentAgentUnscoped, wakeAgent, buildSenderId } =
        await import("./persistent-agent-service.js");
      const agent = await getPersistentAgentUnscoped(trigger.targetId);
      if (!agent) return skip("missing");
      if (!agent.enabled) return skip("disabled");
      const label = firing.ticket ? `${firing.source}:${firing.ticket.source}` : firing.source;
      await wakeAgent({
        agentId: agent.id,
        source: firing.source,
        body: firing.message ?? defaultAgentMessage(trigger.id, firing),
        senderType: "system",
        senderId: buildSenderId({ type: "system", label }),
        senderName: firing.title ?? SOURCE_SENDER[firing.source],
        structuredPayload: firing.params,
      });
      return { kind: "persistent_agent", id: agent.id };
    }

    case "pr_review": {
      const { reReview } = await import("./pr-review-service.js");
      const result = await reReview(trigger.targetId);
      return { kind: "pr_review_run", id: result.run.id };
    }

    default:
      return skip(`type "${trigger.targetType}" unknown`);
  }
}

const SOURCE_SENDER: Record<TriggerFiring["source"], string> = {
  schedule: "Scheduler",
  webhook: "Webhook",
  ticket: "Ticket",
  github: "GitHub",
  slack: "Slack",
  linear: "Linear",
};

function defaultAgentMessage(triggerId: string, firing: TriggerFiring): string {
  const head =
    firing.source === "schedule"
      ? `Scheduled tick (trigger ${triggerId}).`
      : `${SOURCE_SENDER[firing.source]} trigger ${triggerId} fired.`;
  return firing.params && Object.keys(firing.params).length > 0
    ? `${head} Payload:\n${JSON.stringify(firing.params, null, 2)}`
    : head;
}

// ── Ticket fan-out ──────────────────────────────────────────────────────────

export type TicketFireResult = TriggerFireResult & { triggerId: string };

/**
 * Fire every enabled `ticket` trigger whose filters (`source`, any-match
 * `labels`) match the ticket, whatever it targets. Failures are per-trigger:
 * logged, and the sweep goes on.
 */
export async function fireTicketTriggers(ticket: TicketFiring): Promise<TicketFireResult[]> {
  const candidates = await listEnabledTriggersOfType("ticket");
  const results: TicketFireResult[] = [];
  for (const trigger of candidates) {
    if (!ticketTriggerMatches((trigger.config ?? {}) as Record<string, unknown>, ticket)) continue;
    try {
      const fired = await fireTrigger(trigger, {
        source: "ticket",
        params: ticketTriggerParams(ticket),
        ticket: { source: ticket.source, externalId: ticket.externalId, url: ticket.url },
        title: `${ticket.externalId} ${ticket.title}`,
        message: [
          `Ticket ${ticket.externalId} (${ticket.source}): ${ticket.title}`,
          ticket.url ?? null,
          ticket.body ? `\n${ticket.body}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      });
      if (fired) results.push({ ...fired, triggerId: trigger.id });
    } catch (err) {
      logger.error(
        { err, triggerId: trigger.id, targetType: trigger.targetType, ticket: ticket.externalId },
        "Failed to fire ticket trigger",
      );
    }
  }
  return results;
}
