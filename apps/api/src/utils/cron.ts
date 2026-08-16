import { CronExpressionParser } from "cron-parser";

/**
 * Next fire time for a cron expression — strictly after now.
 *
 * Shared by every service that stamps `workflow_triggers.next_fire_at`
 * (workflow-service, task-config-service, workflow-trigger-service) so all
 * trigger creation/update paths agree on scheduling semantics. The schedule
 * poller (`getDueScheduleTriggersAll`) only selects rows with
 * `next_fire_at <= now`, so a schedule trigger written without this value
 * never fires.
 *
 * Throws if the expression is not valid cron (callers surface this as a 400).
 */
export function computeNextFire(cronExpression: string): Date {
  return CronExpressionParser.parse(cronExpression).next().toDate();
}
