import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildRequest,
  describeConfig,
  HTTP_METHODS,
  redact,
  shapeResponse,
  type BridgeConfig,
  type RequestInput,
} from "./bridge.js";

export type FetchImpl = (url: URL, init: RequestInit) => Promise<Response>;

const requestInputShape = {
  method: z.enum(HTTP_METHODS).describe("HTTP method"),
  path: z
    .string()
    .describe(
      'Path relative to the base URL, e.g. "/v1/users". No scheme or host; may carry a query string.',
    ),
  query: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Query parameters, appended to the path's own"),
  headers: z
    .record(z.string())
    .optional()
    .describe(
      "Extra request headers. The auth header and the bridge's static headers cannot be overridden.",
    ),
  body: z
    .unknown()
    .optional()
    .describe(
      "Request body. JSON-encoded and sent as application/json unless you set content-type, in which case a string body is sent as-is.",
    ),
};

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/** Builds the MCP server for one bridge config. `fetchImpl` is only swapped in tests. */
export function createServer(
  cfg: BridgeConfig,
  fetchImpl: FetchImpl = (url, init) => fetch(url, init),
): McpServer {
  const server = new McpServer({ name: cfg.name, version: "0.1.0" });
  const about = cfg.description ? `${cfg.name} — ${cfg.description}` : cfg.name;

  server.registerTool(
    "describe",
    {
      title: `About ${cfg.name}`,
      description: `Describes the ${about} API this server proxies: base URL, auth header name, and static headers. Call it first to learn the base URL.`,
      inputSchema: {},
    },
    async () => textResult(describeConfig(cfg)),
  );

  server.registerTool(
    "request",
    {
      title: `Call ${cfg.name}`,
      description: [
        `Makes one HTTP request to the ${about} API (base URL ${cfg.baseUrl.href}).`,
        "Authentication is added for you. The path is relative to the base URL and must stay under it.",
        "Returns the status line, the response content-type, and the body (JSON pretty-printed, capped at 2 MiB).",
        "A non-2xx status is returned as text, not an error.",
      ].join(" "),
      inputSchema: requestInputShape,
    },
    async (input) => {
      const built = buildRequest(cfg, input as RequestInput);
      if (!built.ok) return textResult(`request not sent: ${built.error}`, true);
      try {
        const res = await fetchImpl(built.url, built.init);
        const shaped = await shapeResponse(res);
        return textResult(redact(cfg, shaped.text));
      } catch (err) {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        return textResult(
          redact(
            cfg,
            timedOut
              ? `request timed out after 30 s (${built.init.method} ${built.url.href})`
              : `request failed: ${message}`,
          ),
          true,
        );
      }
    },
  );

  return server;
}
