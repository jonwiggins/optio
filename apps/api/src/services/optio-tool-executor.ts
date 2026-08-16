/**
 * Execute Optio tool calls by routing them to the local API via Fastify inject.
 *
 * This avoids network round-trips — the tool executor calls API route handlers
 * directly within the same process.
 */

import type { FastifyInstance } from "fastify";
import { OPTIO_TOOL_MAP, TERMINAL_TASK_STATES } from "@optio/shared";
import { logger } from "../logger.js";

const log = logger.child({ service: "optio-tool-executor" });

/** Maximum length for tool result strings sent back to the model. */
export const MAX_TOOL_RESULT_LENGTH = 8_000;

// ─── watch_task polling bounds ──────────────────────────────────────────────
//
// watch_task promises to poll a task until it reaches a terminal state. These
// bounds keep that promise honest without letting a single tool call block the
// conversation forever.

/** Floor for the poll interval, in seconds (regardless of requested value). */
export const WATCH_MIN_POLL_INTERVAL_SEC = 2;
/** Ceiling for the poll interval, in seconds. */
export const WATCH_MAX_POLL_INTERVAL_SEC = 60;
/** Poll interval used when the caller does not specify one. */
export const WATCH_DEFAULT_POLL_INTERVAL_SEC = 10;
/** Floor for the overall watch timeout, in minutes. */
export const WATCH_MIN_TIMEOUT_MIN = 1;
/** Hard cap on how long a single watch may run, in minutes. Never block longer. */
export const WATCH_MAX_TIMEOUT_MIN = 30;
/** Timeout used when the caller does not specify one. */
export const WATCH_DEFAULT_TIMEOUT_MIN = 10;

const TERMINAL_STATES: ReadonlySet<string> = new Set(TERMINAL_TASK_STATES);

/** Injectable timing hooks so tests can drive the poll loop without real waits. */
export interface WatchTaskOptions {
  /** Delay between polls. Defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Current-time source. Defaults to `Date.now`. */
  now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Pull the task state out of a `GET /api/tasks/:id` response body. */
function extractTaskState(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      state?: unknown;
      task?: { state?: unknown } | null;
    };
    // The enriched detail endpoint wraps the row: `{ task: { state, ... }, ... }`.
    const state = parsed.task?.state ?? parsed.state;
    return typeof state === "string" ? state : null;
  } catch {
    return null;
  }
}

function safeParseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/**
 * Poll `GET /api/tasks/:id` until the task reaches a terminal state
 * (see `TERMINAL_TASK_STATES`) or the timeout elapses.
 *
 * Returns the final observed task detail on success. On timeout it still
 * returns success with the last-observed state, clearly flagged as
 * "still <state> after timeout" so the assistant can report it accurately.
 * A failed lookup (non-2xx) is surfaced immediately — polling won't fix a 404.
 */
export async function watchTask(
  app: FastifyInstance,
  toolInput: Record<string, unknown>,
  sessionToken: string,
  options: WatchTaskOptions = {},
): Promise<{ success: boolean; result: string }> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  const id = toolInput.id;
  if (typeof id !== "string" || id.length === 0) {
    return {
      success: false,
      result: JSON.stringify({ error: "watch_task requires a string task id" }),
    };
  }

  const pollIntervalSec = clamp(
    toFiniteNumber(toolInput.pollIntervalSeconds, WATCH_DEFAULT_POLL_INTERVAL_SEC),
    WATCH_MIN_POLL_INTERVAL_SEC,
    WATCH_MAX_POLL_INTERVAL_SEC,
  );
  const timeoutMin = clamp(
    toFiniteNumber(toolInput.timeoutMinutes, WATCH_DEFAULT_TIMEOUT_MIN),
    WATCH_MIN_TIMEOUT_MIN,
    WATCH_MAX_TIMEOUT_MIN,
  );

  const pollIntervalMs = pollIntervalSec * 1000;
  const deadline = now() + timeoutMin * 60_000;
  const url = `/api/tasks/${encodeURIComponent(id)}`;

  let polls = 0;
  let lastBody = "";
  let lastState = "unknown";

  while (true) {
    polls++;
    const response = await app.inject({
      method: "GET",
      url,
      headers: {
        cookie: `optio_session=${sessionToken}`,
        "content-type": "application/json",
      },
    });
    const statusOk = response.statusCode >= 200 && response.statusCode < 300;
    lastBody = response.body;

    if (!statusOk) {
      log.warn(
        { toolName: "watch_task", id, status: response.statusCode },
        "watch_task poll failed",
      );
      return { success: false, result: lastBody };
    }

    lastState = extractTaskState(lastBody) ?? lastState;

    if (TERMINAL_STATES.has(lastState)) {
      log.info(
        { toolName: "watch_task", id, state: lastState, polls },
        "watch_task reached terminal state",
      );
      return {
        success: true,
        result: JSON.stringify({
          watch: "terminal",
          state: lastState,
          polls,
          task: safeParseJson(lastBody),
        }),
      };
    }

    // Check the deadline only after at least one poll, so an already-terminal
    // task always returns immediately and a watch always observes state once.
    if (now() >= deadline) {
      log.info({ toolName: "watch_task", id, state: lastState, polls }, "watch_task timed out");
      return {
        success: true,
        result: JSON.stringify({
          watch: "timeout",
          message: `Task still ${lastState} after ${timeoutMin} minute timeout`,
          state: lastState,
          timeoutMinutes: timeoutMin,
          polls,
          task: safeParseJson(lastBody),
        }),
      };
    }

    await sleep(pollIntervalMs);
  }
}

/**
 * Execute a single Optio tool call by making an internal API request.
 *
 * @param app           Fastify instance (used for `app.inject`)
 * @param toolName      Name of the tool (must match an OPTIO_TOOL_SCHEMAS entry)
 * @param toolInput     Input parameters from the model
 * @param sessionToken  The user's session token for auth
 */
export async function executeToolCall(
  app: FastifyInstance,
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionToken: string,
): Promise<{ success: boolean; result: string }> {
  const schema = OPTIO_TOOL_MAP[toolName];
  if (!schema) {
    return { success: false, result: JSON.stringify({ error: `Unknown tool: ${toolName}` }) };
  }

  // watch_task is a long-running poll, not a one-shot REST call. The generic
  // inject path below would serialize pollIntervalSeconds/timeoutMinutes into a
  // query string that GET /api/tasks/:id ignores, returning an immediate
  // snapshot. Dispatch to the dedicated poller so the tool honors its contract.
  if (toolName === "watch_task") {
    return watchTask(app, toolInput, sessionToken);
  }

  try {
    // Parse endpoint template: "GET /api/tasks/:id"
    const spaceIdx = schema.endpoint.indexOf(" ");
    const urlTemplate = spaceIdx >= 0 ? schema.endpoint.slice(spaceIdx + 1) : schema.endpoint;
    let url = urlTemplate;

    // Replace path parameters (:id, etc.)
    const pathParams = new Set<string>();
    for (const [key, value] of Object.entries(toolInput)) {
      const placeholder = `:${key}`;
      if (url.includes(placeholder)) {
        url = url.replace(placeholder, encodeURIComponent(String(value)));
        pathParams.add(key);
      }
    }

    // Remaining params → query string (GET) or JSON body (POST/PATCH/DELETE)
    const remainingParams = Object.fromEntries(
      Object.entries(toolInput).filter(
        ([key, value]) => !pathParams.has(key) && value !== undefined,
      ),
    );

    if (schema.method === "GET" && Object.keys(remainingParams).length > 0) {
      const qs = new URLSearchParams(
        Object.entries(remainingParams).map(([k, v]) => [k, String(v)]),
      );
      url += `?${qs.toString()}`;
    }

    const injectOptions: Record<string, unknown> = {
      method: schema.method,
      url,
      headers: {
        cookie: `optio_session=${sessionToken}`,
        "content-type": "application/json",
      },
    };

    if (schema.method !== "GET" && Object.keys(remainingParams).length > 0) {
      injectOptions.payload = remainingParams;
    }

    const response = await app.inject(injectOptions);
    const statusOk = response.statusCode >= 200 && response.statusCode < 300;

    log.info({ toolName, url, status: response.statusCode, ok: statusOk }, "Tool call executed");

    return { success: statusOk, result: response.body };
  } catch (err) {
    log.error({ err, toolName }, "Tool execution failed");
    return {
      success: false,
      result: JSON.stringify({
        error: `Internal error executing ${toolName}: ${err instanceof Error ? err.message : String(err)}`,
      }),
    };
  }
}

/** Truncate a tool result to stay within context limits. */
export function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_LENGTH) return result;
  return result.slice(0, MAX_TOOL_RESULT_LENGTH) + "… (truncated)";
}
