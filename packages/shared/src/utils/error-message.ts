/**
 * A readable message for anything a `catch` can receive.
 *
 * `String(err)` reads fine for an Error or a string, but a rejection is not
 * always one: the Kubernetes client's exec rejects with the WebSocket's
 * ErrorEvent, an HTTP client with a response body, and `String()` of either
 * is "[object Object]" — which is what a task then showed as its error. This
 * digs the message out instead, keeping a specific error's name
 * ("StateRaceError: …") and dropping the generic "Error: " prefix.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const message = err.message || String(err);
    return err.name && err.name !== "Error" && !message.startsWith(`${err.name}:`)
      ? `${err.name}: ${message}`
      : message;
  }
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    // A WebSocket ErrorEvent: { type: "error", error: Error, message }.
    if (o.error instanceof Error) return describeError(o.error);
    if (typeof o.message === "string" && o.message) return o.message;
    // An API client's exception: { body: { message } | string, statusCode }.
    const body = o.body;
    if (body && typeof body === "object") {
      const message = (body as Record<string, unknown>).message;
      if (typeof message === "string" && message) return message;
    }
    if (typeof body === "string" && body) return body;
    try {
      const json = JSON.stringify(err);
      if (json && json !== "{}") return json.length > 500 ? `${json.slice(0, 500)}…` : json;
    } catch {
      // circular: fall through
    }
  }
  return String(err);
}
