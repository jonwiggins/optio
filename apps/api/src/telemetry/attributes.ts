/**
 * Whitelisted attribute keys for OpenTelemetry spans and metrics.
 *
 * Only attributes listed here may be attached to spans. This prevents
 * accidental leakage of prompts, secrets, agent output, or user PII.
 */

// ── Worker attributes ───────────────────────────────────────────────────────

export const WORKER_NAME = "worker.name";
export const WORKER_JOB_ID = "worker.job_id";
export const WORKER_JOB_NAME = "worker.job_name";
export const WORKER_ATTEMPTS = "worker.attempts_made";

// ── Metric names ────────────────────────────────────────────────────────────

export const METRIC_TASKS_TOTAL = "optio_tasks_total";
export const METRIC_TASK_DURATION = "optio_task_duration_seconds";
export const METRIC_TASK_COST = "optio_task_cost_usd";
export const METRIC_TASK_TOKENS = "optio_task_tokens";
export const METRIC_QUEUE_DEPTH = "optio_queue_depth";
export const METRIC_ACTIVE_TASKS = "optio_active_tasks";
export const METRIC_POD_COUNT = "optio_pod_count";
export const METRIC_PR_WATCH_DURATION = "optio_pr_watch_cycle_duration_seconds";
export const METRIC_STATE_TRANSITIONS = "optio_state_transitions_total";
export const METRIC_WORKER_JOB_DURATION = "optio_worker_job_duration_seconds";
export const METRIC_POD_HEALTH_EVENTS = "optio_pod_health_events_total";
export const METRIC_WEBHOOK_DELIVERIES = "optio_webhook_deliveries_total";
