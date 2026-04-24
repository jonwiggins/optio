import type { FastifyInstance } from "fastify";
import { getSettings } from "../services/optio-settings-service.js";
import { authenticateWs, extractSessionToken } from "./ws-auth.js";
import { logger } from "../logger.js";
import {
  OPTIO_TOOL_SCHEMAS,
  OPTIO_TOOL_CATEGORIES,
  type OptioToolDefinition,
  type OptioToolSchema,
} from "@optio/shared";
import { executeToolCall, truncateToolResult } from "../services/optio-tool-executor.js";
import {
  getClientIp,
  trackConnection,
  releaseConnection,
  isMessageWithinSizeLimit,
  WS_CLOSE_CONNECTION_LIMIT,
  WS_CLOSE_MESSAGE_TOO_LARGE,
} from "./ws-limits.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const ANTHROPIC_API_URL = process.env.ANTHROPIC_API_BASE_URL ?? "https://api.anthropic.com";

const ANTHROPIC_MODEL_MAP: Record<string, string> = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TURNS = 10;

// ─── Per-user concurrency tracking ──────────────────────────────────────────

/** Map of userId → active WebSocket (only one active conversation per user). */
const activeConnections = new Map<string, WebSocket>();

/** @internal Reset active connections — only for tests. */
export function _resetActiveConnections(): void {
  activeConnections.clear();
}

// ─── Anthropic API types ────────────────────────────────────────────────────

export interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ─── Tool confirmation classification ───────────────────────────────────────

/** Tool name prefixes that indicate write operations requiring confirmation. */
const WRITE_TOOL_PREFIXES = [
  "create_",
  "retry_",
  "cancel_",
  "update_",
  "bulk_",
  "assign_",
  "delete_",
  "restart_",
  "manage_",
];

export function toolRequiresConfirmation(toolName: string): boolean {
  return WRITE_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

// ─── Tool definition builders ───────────────────────────────────────────────

/**
 * Build a plain-text tool listing from OPTIO_TOOL_CATEGORIES.
 * Kept for backward compatibility — the main flow now uses toAnthropicTools().
 */
export function buildToolDefinitionsBlock(enabledTools: string[]): string {
  const allTools: OptioToolDefinition[] = OPTIO_TOOL_CATEGORIES.flatMap((cat) => cat.tools);
  const tools =
    enabledTools.length > 0 ? allTools.filter((t) => enabledTools.includes(t.name)) : allTools;

  const lines = tools.map((t) => {
    const confirm = toolRequiresConfirmation(t.name);
    return `- ${t.name}: ${t.description} [requiresConfirmation: ${confirm}]`;
  });
  return lines.join("\n");
}

/**
 * Convert OPTIO_TOOL_SCHEMAS into the Anthropic Messages API tool format,
 * optionally filtering to a set of enabled tool names.
 */
export function toAnthropicTools(
  schemas: OptioToolSchema[],
  enabledTools: string[],
): AnthropicTool[] {
  const filtered =
    enabledTools.length > 0 ? schemas.filter((s) => enabledTools.includes(s.name)) : schemas;
  return filtered.map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: s.input_schema,
  }));
}

// ─── System prompt builder ──────────────────────────────────────────────────

export function buildSystemPrompt(settings: {
  systemPrompt: string;
  confirmWrites: boolean;
}): string {
  const parts: string[] = [
    `You are Optio, an AI operations assistant for managing coding agent tasks and infrastructure.`,
    `You help users manage their task pipeline: retry failed tasks, cancel tasks, update repo settings, check status, and more.`,
    ``,
    `## Instructions`,
    `- Use the provided tools to query the Optio API and perform operations.`,
    `- For read operations, call the appropriate tool and present the results clearly.`,
    `- Be concise and direct.`,
    `- When listing tasks, show task ID, title, state, and age.`,
    `- When errors occur, explain what went wrong and suggest fixes.`,
    `- For bulk operations, summarize what will be affected before acting.`,
  ];

  if (settings.confirmWrites) {
    parts.push(
      ``,
      `## Write Operation Policy`,
      `For write operations (create, retry, cancel, update, delete, restart, assign, bulk),` +
        ` explain what you intend to do BEFORE calling the tool.` +
        ` The system will ask the user for confirmation automatically.`,
    );
  }

  if (settings.systemPrompt) {
    parts.push(``, `## Additional Instructions`, settings.systemPrompt);
  }

  return parts.join("\n");
}

// ─── Action proposal / result parsers (kept for backward compat) ────────────

export interface ParsedActionProposal {
  description: string;
  items: string[];
}

export interface ParsedActionResult {
  success: boolean;
  summary: string;
}

const ACTION_PROPOSAL_RE = /ACTION_PROPOSAL:\s*(\{.*\})/;
const ACTION_RESULT_RE = /ACTION_RESULT:\s*(\{.*\})/;

export function parseActionProposal(text: string): ParsedActionProposal | null {
  const match = text.match(ACTION_PROPOSAL_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (parsed.description && Array.isArray(parsed.items)) {
      return { description: parsed.description, items: parsed.items };
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

export function parseActionResult(text: string): ParsedActionResult | null {
  const match = text.match(ACTION_RESULT_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed.success === "boolean" && parsed.summary) {
      return { success: parsed.success, summary: parsed.summary };
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

// ─── Anthropic streaming ────────────────────────────────────────────────────

interface StreamedBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  partialJson?: string;
  input?: Record<string, unknown>;
}

/**
 * Stream an Anthropic Messages API response (SSE), forwarding text deltas
 * to the WebSocket in real time. Returns the collected content blocks and
 * stop reason once the stream ends.
 */
export async function streamAnthropicResponse(
  response: Response,
  send: (msg: Record<string, unknown>) => void,
): Promise<{
  content: AnthropicContentBlock[];
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
}> {
  const blocks: StreamedBlock[] = [];
  let stopReason = "";
  let inputTokens = 0;
  let outputTokens = 0;

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }

      switch (event.type) {
        case "message_start": {
          const msg = event.message as Record<string, unknown> | undefined;
          const usage = msg?.usage as Record<string, number> | undefined;
          if (usage) inputTokens = usage.input_tokens ?? 0;
          break;
        }
        case "content_block_start": {
          const idx = event.index as number;
          const block = event.content_block as Record<string, unknown>;
          if (block.type === "text") {
            blocks[idx] = { type: "text", text: "" };
          } else if (block.type === "tool_use") {
            blocks[idx] = {
              type: "tool_use",
              id: block.id as string,
              name: block.name as string,
              partialJson: "",
            };
          }
          break;
        }
        case "content_block_delta": {
          const idx = event.index as number;
          const delta = event.delta as Record<string, unknown>;
          const block = blocks[idx];
          if (!block) break;

          if (delta.type === "text_delta" && block.type === "text") {
            const text = delta.text as string;
            block.text = (block.text ?? "") + text;
            send({ type: "text", content: text });
          } else if (delta.type === "input_json_delta" && block.type === "tool_use") {
            block.partialJson = (block.partialJson ?? "") + (delta.partial_json as string);
          }
          break;
        }
        case "content_block_stop": {
          const idx = event.index as number;
          const block = blocks[idx];
          if (block?.type === "tool_use" && block.partialJson) {
            try {
              block.input = JSON.parse(block.partialJson);
            } catch {
              block.input = {};
            }
          }
          break;
        }
        case "message_delta": {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.stop_reason) stopReason = delta.stop_reason as string;
          const usage = event.usage as Record<string, number> | undefined;
          if (usage) outputTokens += usage.output_tokens ?? 0;
          break;
        }
      }
    }
  }

  // Convert streamed blocks to AnthropicContentBlocks
  const content: AnthropicContentBlock[] = blocks.filter(Boolean).map((block) => {
    if (block.type === "text") {
      return { type: "text" as const, text: block.text ?? "" };
    }
    return {
      type: "tool_use" as const,
      id: block.id,
      name: block.name,
      input: block.input ?? {},
    };
  });

  return { content, stopReason, inputTokens, outputTokens };
}

// ─── Auth helpers ───────────────────────────────────────────────────────────

/**
 * Retrieve the Anthropic API credentials from the secrets store.
 * Returns the raw key or token for use with the Messages API.
 */
async function getAnthropicAuth(
  log: { warn: (obj: unknown, msg: string) => void },
  userId?: string | null,
): Promise<{ apiKey?: string; oauthToken?: string }> {
  try {
    const { retrieveSecret, retrieveSecretWithFallback } =
      await import("../services/secret-service.js");
    const authMode = (await retrieveSecret("CLAUDE_AUTH_MODE").catch(() => null)) as string | null;

    if (authMode === "api-key") {
      const apiKey = await retrieveSecretWithFallback(
        "ANTHROPIC_API_KEY",
        "global",
        undefined,
        userId,
      ).catch(() => null);
      return apiKey ? { apiKey: apiKey as string } : {};
    } else if (authMode === "oauth-token") {
      const token = await retrieveSecretWithFallback(
        "CLAUDE_CODE_OAUTH_TOKEN",
        "global",
        undefined,
        userId,
      ).catch(() => null);
      return token ? { oauthToken: token as string } : {};
    } else if (authMode === "max-subscription") {
      const { getClaudeAuthToken } = await import("../services/auth-service.js");
      const result = getClaudeAuthToken();
      return result.available && result.token ? { oauthToken: result.token } : {};
    }
  } catch (err) {
    log.warn({ err }, "Failed to get Anthropic auth");
  }
  return {};
}

function buildAnthropicHeaders(auth: {
  apiKey?: string;
  oauthToken?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (auth.apiKey) {
    headers["x-api-key"] = auth.apiKey;
  } else if (auth.oauthToken) {
    headers["authorization"] = `Bearer ${auth.oauthToken}`;
  }
  return headers;
}

// ─── WebSocket handler ──────────────────────────────────────────────────────

export async function optioChatWs(app: FastifyInstance) {
  app.get("/ws/optio/chat", { websocket: true }, async (socket, req) => {
    const clientIp = getClientIp(req);

    if (!trackConnection(clientIp)) {
      socket.close(WS_CLOSE_CONNECTION_LIMIT, "Too many connections");
      return;
    }

    const user = await authenticateWs(socket, req);
    if (!user) {
      releaseConnection(clientIp);
      return;
    }

    const userId = user.id;
    const log = logger.child({ userId, ws: "optio-chat" });

    // Enforce one active conversation per user
    if (activeConnections.has(userId)) {
      socket.send(
        JSON.stringify({
          type: "error",
          message: "You already have an active Optio conversation. Close the other one first.",
        }),
      );
      releaseConnection(clientIp);
      socket.close(4409, "Concurrent conversation");
      return;
    }

    activeConnections.set(userId, socket as unknown as WebSocket);
    log.info("Optio chat connected");

    // Extract session token for tool execution (cookie only — never URL query params).
    // The upgrade token from Sec-WebSocket-Protocol is single-use and already consumed
    // by authenticateWs(), so it cannot be reused for API passthrough.
    const sessionToken = extractSessionToken(req) ?? "";

    let isProcessing = false;
    let abortController: AbortController | null = null;
    let currentActionId: string | null = null;

    // Conversation state for the multi-turn tool-use loop
    let conversationMessages: Array<{
      role: "user" | "assistant";
      content: string | AnthropicContentBlock[];
    }> = [];
    let pendingWriteToolCalls: AnthropicContentBlock[] = [];
    let pendingReadResults: AnthropicContentBlock[] = [];

    const send = (msg: Record<string, unknown>) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(msg));
      }
    };

    // Send initial ready status
    send({ type: "status", status: "ready" });

    /**
     * Run the tool-use loop: call Anthropic Messages API, handle tool calls,
     * repeat until the model stops or we hit maxTurns.
     */
    const runToolLoop = async (
      systemPrompt: string,
      tools: AnthropicTool[],
      auth: { apiKey?: string; oauthToken?: string },
      model: string,
      maxTurns: number,
      confirmWrites: boolean,
    ) => {
      const headers = buildAnthropicHeaders(auth);

      for (let turn = 0; turn < maxTurns; turn++) {
        abortController = new AbortController();

        const body = {
          model,
          system: systemPrompt,
          messages: conversationMessages,
          ...(tools.length > 0 ? { tools } : {}),
          max_tokens: 4096,
          stream: true,
        };

        let response: Response;
        try {
          response = await fetch(`${ANTHROPIC_API_URL}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: abortController.signal,
          });
        } catch (err) {
          if ((err as Error).name === "AbortError") {
            log.info("Anthropic API call aborted");
            return;
          }
          throw err;
        }

        if (!response.ok) {
          const errorBody = await response.text();
          log.error({ status: response.status, body: errorBody }, "Anthropic API error");
          send({
            type: "error",
            message: `API error (${response.status}): ${errorBody.slice(0, 200)}`,
          });
          return;
        }

        const { content, stopReason } = await streamAnthropicResponse(response, send);

        abortController = null;

        // Add assistant response to conversation
        conversationMessages.push({ role: "assistant", content });

        // If no tool calls, we're done
        if (stopReason !== "tool_use") {
          return;
        }

        // Separate tool calls into reads and writes
        const toolCalls = content.filter((b) => b.type === "tool_use");
        const readCalls = toolCalls.filter((t) => !toolRequiresConfirmation(t.name!));
        const writeCalls = toolCalls.filter((t) => toolRequiresConfirmation(t.name!));

        // Execute read calls immediately
        const readResults: AnthropicContentBlock[] = [];
        for (const tc of readCalls) {
          const result = await executeToolCall(
            app,
            tc.name!,
            (tc.input ?? {}) as Record<string, unknown>,
            sessionToken,
          );
          readResults.push({
            type: "tool_result",
            tool_use_id: tc.id!,
            content: truncateToolResult(result.result),
            is_error: !result.success,
          });
        }

        // If there are write calls and confirmation is enabled, pause for approval
        if (writeCalls.length > 0 && confirmWrites) {
          pendingWriteToolCalls = writeCalls;
          pendingReadResults = readResults;

          const items = writeCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.input)})`);
          currentActionId = `action-${Date.now()}`;
          send({
            type: "action_proposal",
            actionId: currentActionId,
            description: `Execute ${writeCalls.length} write operation(s)`,
            items,
          });
          send({ type: "status", status: "waiting_for_approval" });
          return; // Wait for approve/deny message
        }

        // Execute write calls immediately (no confirmation needed)
        const writeResults: AnthropicContentBlock[] = [];
        for (const tc of writeCalls) {
          const result = await executeToolCall(
            app,
            tc.name!,
            (tc.input ?? {}) as Record<string, unknown>,
            sessionToken,
          );
          writeResults.push({
            type: "tool_result",
            tool_use_id: tc.id!,
            content: truncateToolResult(result.result),
            is_error: !result.success,
          });
          send({
            type: "action_result",
            success: result.success,
            summary: `${tc.name}: ${result.success ? "success" : "failed"}`,
          });
        }

        // Feed all tool results back to the model
        conversationMessages.push({
          role: "user",
          content: [...readResults, ...writeResults],
        });
      }

      // Max turns reached
      send({ type: "text", content: "\n\n(Reached maximum conversation turns)" });
    };

    /**
     * Process a new user message.
     */
    const runPrompt = async (
      userMessage: string,
      conversationContext: Array<{ role: string; content: string }>,
    ) => {
      if (isProcessing) {
        send({ type: "error", message: "Already processing a request" });
        return;
      }

      isProcessing = true;
      currentActionId = null;
      pendingWriteToolCalls = [];
      pendingReadResults = [];
      send({ type: "status", status: "thinking" });

      // Get Anthropic credentials
      const auth = await getAnthropicAuth(log, userId);
      if (!auth.apiKey && !auth.oauthToken) {
        send({
          type: "error",
          message:
            "No Anthropic credentials configured. Set up an API key or OAuth token in the setup wizard.",
        });
        isProcessing = false;
        send({ type: "status", status: "ready" });
        return;
      }

      // Load settings
      const settings = await getSettings(user.workspaceId);
      const model = ANTHROPIC_MODEL_MAP[settings.model] ?? DEFAULT_MODEL;
      const maxTurns = settings.maxTurns || DEFAULT_MAX_TURNS;

      // Build system prompt (tool definitions are passed separately to the API)
      const systemPrompt = buildSystemPrompt({
        systemPrompt: settings.systemPrompt,
        confirmWrites: settings.confirmWrites,
      });

      // Build tool definitions in Anthropic format
      const tools = toAnthropicTools(OPTIO_TOOL_SCHEMAS, settings.enabledTools);

      // Build messages from conversation context
      conversationMessages = [];
      for (const msg of conversationContext) {
        conversationMessages.push({
          role: msg.role === "user" ? "user" : "assistant",
          content: msg.content,
        });
      }
      conversationMessages.push({ role: "user", content: userMessage });

      try {
        await runToolLoop(systemPrompt, tools, auth, model, maxTurns, settings.confirmWrites);
      } catch (err) {
        log.error({ err }, "Tool loop failed");
        send({ type: "error", message: "Failed to process request" });
      } finally {
        if (!currentActionId) {
          // Only mark ready if we're not waiting for approval
          isProcessing = false;
          send({ type: "status", status: "ready" });
        }
      }
    };

    /**
     * Continue the tool-use loop after user approves or denies a write action.
     */
    const continueAfterDecision = async (approved: boolean, feedback?: string) => {
      send({ type: "status", status: approved ? "executing" : "thinking" });

      const auth = await getAnthropicAuth(log, userId);
      if (!auth.apiKey && !auth.oauthToken) {
        send({ type: "error", message: "No Anthropic credentials configured" });
        isProcessing = false;
        send({ type: "status", status: "ready" });
        return;
      }

      const settings = await getSettings(user.workspaceId);
      const model = ANTHROPIC_MODEL_MAP[settings.model] ?? DEFAULT_MODEL;
      const maxTurns = settings.maxTurns || DEFAULT_MAX_TURNS;
      const systemPrompt = buildSystemPrompt({
        systemPrompt: settings.systemPrompt,
        confirmWrites: settings.confirmWrites,
      });
      const tools = toAnthropicTools(OPTIO_TOOL_SCHEMAS, settings.enabledTools);

      // Build tool results for the pending write calls
      const writeResults: AnthropicContentBlock[] = [];
      for (const tc of pendingWriteToolCalls) {
        if (approved) {
          const result = await executeToolCall(
            app,
            tc.name!,
            (tc.input ?? {}) as Record<string, unknown>,
            sessionToken,
          );
          writeResults.push({
            type: "tool_result",
            tool_use_id: tc.id!,
            content: truncateToolResult(result.result),
            is_error: !result.success,
          });
          send({
            type: "action_result",
            success: result.success,
            summary: `${tc.name}: ${result.success ? "success" : "failed"}`,
          });
        } else {
          writeResults.push({
            type: "tool_result",
            tool_use_id: tc.id!,
            content: feedback
              ? `User denied this action. Feedback: "${feedback}"`
              : "User denied this action.",
            is_error: true,
          });
        }
      }

      // Append all tool results (reads executed earlier + writes just resolved)
      conversationMessages.push({
        role: "user",
        content: [...pendingReadResults, ...writeResults],
      });

      pendingWriteToolCalls = [];
      pendingReadResults = [];
      currentActionId = null;

      try {
        await runToolLoop(systemPrompt, tools, auth, model, maxTurns, settings.confirmWrites);
      } catch (err) {
        log.error({ err }, "Tool loop continuation failed");
        send({ type: "error", message: "Failed to continue" });
      } finally {
        isProcessing = false;
        send({ type: "status", status: "ready" });
      }
    };

    // Handle incoming messages from the client
    socket.on("message", (data: Buffer | string) => {
      if (!isMessageWithinSizeLimit(data)) {
        socket.close(WS_CLOSE_MESSAGE_TOO_LARGE, "Message too large");
        return;
      }

      const str = typeof data === "string" ? data : data.toString("utf-8");

      let msg: {
        type: string;
        content?: string;
        conversationContext?: Array<{ role: string; content: string }>;
        actionId?: string;
        feedback?: string;
      };
      try {
        msg = JSON.parse(str);
      } catch {
        send({ type: "error", message: "Invalid JSON message" });
        return;
      }

      switch (msg.type) {
        case "message":
          if (!msg.content?.trim()) {
            send({ type: "error", message: "Empty message" });
            return;
          }
          runPrompt(msg.content, msg.conversationContext ?? []).catch((err) => {
            log.error({ err }, "Prompt execution failed");
            send({ type: "error", message: "Prompt failed" });
            isProcessing = false;
            send({ type: "status", status: "ready" });
          });
          break;

        case "approve":
          if (!currentActionId || msg.actionId !== currentActionId) {
            send({ type: "error", message: "No pending action to approve" });
            return;
          }
          continueAfterDecision(true).catch((err) => {
            log.error({ err }, "Approval execution failed");
            send({ type: "error", message: "Execution failed" });
            isProcessing = false;
            send({ type: "status", status: "ready" });
          });
          break;

        case "deny":
          if (!currentActionId || msg.actionId !== currentActionId) {
            send({ type: "error", message: "No pending action to deny" });
            return;
          }
          continueAfterDecision(false, msg.feedback).catch((err) => {
            log.error({ err }, "Denial follow-up failed");
            send({ type: "error", message: "Follow-up failed" });
            isProcessing = false;
            send({ type: "status", status: "ready" });
          });
          break;

        case "interrupt":
          if (abortController) {
            log.info("Interrupting Anthropic API call");
            abortController.abort();
            abortController = null;
          }
          isProcessing = false;
          currentActionId = null;
          pendingWriteToolCalls = [];
          pendingReadResults = [];
          conversationMessages = [];
          send({ type: "status", status: "ready" });
          break;

        default:
          send({ type: "error", message: `Unknown message type: ${msg.type}` });
      }
    });

    socket.on("close", () => {
      log.info("Optio chat disconnected");
      releaseConnection(clientIp);
      activeConnections.delete(userId);
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
    });
  });
}
