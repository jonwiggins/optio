import { getAdapter } from "@optio/agent-adapters";
import type { AgentResult, AgentLogEntry, ExecSession } from "@optio/shared";
import { shellQuote } from "@optio/shared";
import {
  claimSessionTurn,
  finishSessionTurn,
  broadcastSessionChat,
  watchTurnControl,
} from "./session-turn-service.js";
import { getRuntime } from "./container-service.js";
import {
  GATEWAY_AUTH_MODE,
  applyGatewayEnv,
  gatewayAuthSetup,
  resolveGatewayRun,
} from "./gateway-run-service.js";
import {
  appendSessionChatEvent,
  getSession,
  updateSessionAgentSessionId,
} from "./interactive-session-service.js";
import { getSettings } from "./optio-settings-service.js";
import { db } from "../db/client.js";
import { repos, interactiveSessions, sessionChatTurns } from "../db/schema.js";
import { getPod } from "./agent-pod-pool.js";
import { eq, and, isNull, sql } from "drizzle-orm";
import { logger } from "../logger.js";
import { parseClaudeEvent } from "./agent-event-parser.js";
import {
  buildClaudeChatCommand,
  inspectClaudeLine,
  parseExitSentinel,
  shouldFallbackToFreshSession,
} from "../ws/session-chat-resume.js";

/** Shared legacy pod chat runner: the session UI and controller use the same claims, resume and stream. */
export async function createLegacySessionChat(
  session: typeof interactiveSessions.$inferSelect,
  send: (frame: Record<string, unknown>) => void,
  callerUserId?: string,
  userSessionToken?: string | null,
) {
  const sessionId = session.id;
  const log = logger.child({ sessionId, service: "session-chat" });
  // Get pod info
  const pod = session.podId ? await getPod(session.podId) : null;
  if (!pod || !pod.podName) {
    throw new Error(
      "Session pod was cleaned up due to inactivity. Please end this session and start a new one.",
    );
  }

  // Get repo config for model defaults
  const [repoConfig] = await db
    .select()
    .from(repos)
    .where(
      and(
        eq(repos.repoUrl, session.repoUrl),
        session.workspaceId
          ? eq(repos.workspaceId, session.workspaceId)
          : isNull(repos.workspaceId),
      ),
    );

  // Load Optio agent settings (model, system prompt, tool filtering, etc.)
  // for the caller's workspace. (Not req.user: the HTTP auth plugin skips
  // /ws/ routes, so it is never set here.)
  const optioSettings = await getSettings(session.workspaceId);

  // Optio settings take precedence, then repo config, then default
  let currentModel = optioSettings.model || repoConfig?.claudeModel || "sonnet";

  const rt = getRuntime();
  const handle = { id: pod.podId ?? pod.podName, name: pod.podName };
  const worktreePath = session.worktreePath ?? "/workspace/repo";

  let execSession: ExecSession | null = null;
  // The session's running total, not this socket's: a reconnect (or a
  // second tab) continues from what the session has already spent.
  let cumulativeCost = Number.parseFloat(session.costUsd ?? "") || 0;
  let isProcessing = false;
  let outputBuffer = "";
  let promptCount = 0;
  // Claude Code session id this chat resumes from. Loaded from the session
  // row so a new WS connection continues the same conversation.
  let agentSessionId: string | null = session.agentSessionId ?? null;

  // Resolve auth env vars for the claude process. Through the model gateway
  // (docs/model-gateway.md) when the workspace has one: its env with the
  // person's own token and the catalog's model (the chat's setting may
  // predate the gateway, so one it doesn't serve becomes its first). A
  // missing token throws here, as a lost pod does above.
  const gatewayRun = await resolveGatewayRun({
    agentType: "claude-code",
    agentOptions: { claudeModel: currentModel },
    workspaceId: session.workspaceId,
    ownerUserId: session.userId,
    unservedModel: "first",
  });
  if (gatewayRun) currentModel = gatewayRun.pick.model;
  const authEnv = gatewayRun
    ? applyGatewayEnv({ OPTIO_AUTH_MODE: GATEWAY_AUTH_MODE }, gatewayRun)
    : await buildAuthEnv(log, session.userId, session.workspaceId);
  const broadcast = (msg: Record<string, unknown>) => broadcastSessionChat(sessionId, msg);
  const rememberAgentSessionId = (id: string) => {
    if (id === agentSessionId) return;
    const isFirst = agentSessionId === null;
    agentSessionId = id;
    log.info({ agentSessionId: id, isFirst }, "Claude session id captured");
    persistChain = persistChain
      .then(() => updateSessionAgentSessionId(sessionId, id))
      .catch((err) => {
        log.warn({ err }, "Failed to persist agent session id");
      });
  };

  const forgetAgentSessionId = async (reason: string) => {
    const stale = agentSessionId;
    agentSessionId = null;
    log.warn({ staleAgentSessionId: stale, reason }, "Clearing unresumable Claude session id");
    await updateSessionAgentSessionId(sessionId, null).catch((err) => {
      log.warn({ err }, "Failed to clear agent session id");
    });
  };

  // One insert at a time, in emission order: the stored order (seq) is the
  // replay order, and concurrent fire-and-forget inserts could land in any
  // order. Persistence stays off the streaming path.
  let persistChain: Promise<void> = Promise.resolve();
  const persist = (input: Parameters<typeof appendSessionChatEvent>[0], what: string) => {
    persistChain = persistChain
      .then(() => appendSessionChatEvent(input))
      .then(
        () => undefined,
        (err) => log.warn({ err }, `Failed to persist ${what}`),
      );
  };

  const emitEntry = (entry: AgentLogEntry) => {
    broadcast({ type: "chat_event", event: entry });
    persist(chatEventRow(sessionId, entry), "session chat event");

    // Extract cost from result events
    if (entry.metadata?.cost && typeof entry.metadata.cost === "number") {
      const turnCost = entry.metadata.cost;
      cumulativeCost += turnCost;
      broadcast({ type: "cost_update", costUsd: cumulativeCost });

      // Add this turn to the stored total (never overwrite it with this
      // socket's view, which would drop spend from earlier connections).
    }
  };

  /**
   * Run one `claude -p` exec for a prompt, optionally resuming a Claude
   * session. Resolves with whether the turn should be retried as a fresh
   * conversation because `--resume` could not find the session.
   *
   * Until a resumed turn has produced the init event, its output is held
   * back: if the turn turns out to be a failed resume, the "No conversation
   * found" noise and the error result are swallowed instead of being shown
   * to the user before the retry.
   */
  const executeTurn = async (
    fullPrompt: string,
    resumeSessionId: string | null,
    turnId: string,
  ): Promise<{ fallback: boolean; completed: boolean; interrupted: boolean }> => {
    // Build auth passthrough env vars so the agent can make
    // authenticated API calls on behalf of the requesting user.
    const passthroughEnv: Record<string, string> = {};
    if (userSessionToken && session.userId === callerUserId) {
      passthroughEnv.OPTIO_SESSION_TOKEN = userSessionToken;
    }
    const apiUrl = process.env.PUBLIC_URL || process.env.OPTIO_API_URL || "";
    if (apiUrl) {
      passthroughEnv.OPTIO_API_URL = apiUrl;
    }

    const script = [
      "set -e",
      // Wait for repo to be ready
      "for i in $(seq 1 30); do [ -f /workspace/.ready ] && break; sleep 1; done",
      '[ -f /workspace/.ready ] || { echo "Repo not ready"; exit 1; }',
      `cd ${shellQuote(worktreePath)}`,
      // Set auth env vars for the Claude process (a gateway run drops the
      // pod's own Anthropic key first, so the token is the one sign-in)
      ...gatewayAuthSetup(authEnv),
      ...Object.entries(authEnv).map(([k, v]) => `export ${k}=${shellQuote(v)}`),
      // Set auth passthrough env vars for Optio API calls
      ...Object.entries(passthroughEnv).map(([k, v]) => `export ${k}=${shellQuote(v)}`),
      // This lock outlives an API process: an orphaned turn cannot overlap
      // a new one after worker loss. Never replay an uncertain prompt.
      `exec 8>${shellQuote(`/home/agent/.optio-chat-${sessionId}.lock`)}`,
      "flock -n 8 || { echo 'Previous turn is still running in the pod; inspect it before continuing.' >&2; exit 75; }",
      // Run claude in one-shot prompt mode with streaming JSON output,
      // resuming the stored conversation when we have one.
      buildClaudeChatCommand({ prompt: fullPrompt, model: currentModel, resumeSessionId }),
    ].join("\n");

    const resumed = resumeSessionId !== null;
    let sawInit = false;
    let sawErrorResult = false;
    let exitCode: number | null = null;
    let rawOutput = "";
    let heldBack: AgentLogEntry[] = [];
    const usageParser = getAdapter("claude-code").createResultParser();
    const saveUsage = () => {
      const usage = usageParser.finish(exitCode ?? 0);
      persistChain = persistChain
        .then(() => recordSessionUsage(turnId, sessionId, usage))
        .catch((err) => log.warn({ err }, "Failed to record session usage"));
    };

    const flushHeldBack = () => {
      for (const entry of heldBack) emitEntry(entry);
      heldBack = [];
    };

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      const sentinel = parseExitSentinel(line);
      if (sentinel !== null) {
        exitCode = sentinel;
        return;
      }
      usageParser.push(line);
      try {
        if (JSON.parse(line).type === "result") saveUsage();
      } catch {
        /* non-JSON output */
      }
      const info = inspectClaudeLine(line);
      if (info.isInit) {
        sawInit = true;
        if (info.sessionId) rememberAgentSessionId(info.sessionId);
        flushHeldBack();
      } else if (!sawInit) {
        if (info.isErrorResult) sawErrorResult = true;
        if (!info.sessionId) rawOutput += line + "\n";
      }
      const { entries } = parseClaudeEvent(line, sessionId);
      for (const entry of entries) {
        if (resumed && !sawInit) heldBack.push(entry);
        else emitEntry(entry);
      }
    };

    execSession = await rt.exec(handle, ["bash", "-c", script], { tty: false });
    const thisExec = execSession;
    // An interrupt from any instance (a socket's `interrupt`, the session
    // ended, the durable flag) closes this exec; the watch polls the flag
    // while the turn runs (session-turn-service.ts).
    let interrupted = false;
    const stopWatch = watchTurnControl(sessionId, turnId, () => {
      interrupted = true;
      thisExec.close();
    });

    thisExec.stdout.on("data", (chunk: Buffer) => {
      outputBuffer += chunk.toString("utf-8");

      // Process complete lines
      const lines = outputBuffer.split("\n");
      outputBuffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });

    thisExec.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) {
        rawOutput += text + "\n";
        const entry: AgentLogEntry = {
          taskId: sessionId,
          timestamp: new Date().toISOString(),
          type: "error",
          content: text,
        };
        if (resumed && !sawInit) heldBack.push(entry);
        else emitEntry(entry);
      }
    });

    // Wait for the exec to finish
    try {
      await new Promise<void>((resolve) => {
        thisExec.stdout.on("end", () => {
          // Process any remaining buffer
          if (outputBuffer.trim()) handleLine(outputBuffer);
          outputBuffer = "";
          resolve();
        });
      });
    } finally {
      stopWatch();
    }

    const fallback = shouldFallbackToFreshSession({
      resumed,
      exitCode,
      sawInit,
      sawErrorResult,
      rawOutput,
    });
    if (fallback) {
      log.warn(
        { resumeSessionId, exitCode },
        "Claude --resume failed; retrying prompt as a fresh conversation",
      );
    } else {
      flushHeldBack();
    }
    if (!fallback) {
      saveUsage();
      await persistChain;
    }
    return { fallback, completed: exitCode === 0 && !interrupted, interrupted };
  };

  /**
   * Execute a single claude prompt in the pod worktree, resuming the
   * stored Claude session so successive messages share one conversation.
   */
  const runPrompt = async (
    prompt: string,
    requestId: string,
    onAccepted?: (turnId: string) => void,
  ) => {
    if (isProcessing) {
      send({ type: "error", message: "Agent is already processing a request" });
      return;
    }

    const { usageBudgetHold } = await import("./usage-budget-service.js");
    const budgetHold = await usageBudgetHold({
      workspaceId: session.workspaceId,
      ownerUserId: session.userId,
      workId: sessionId,
    });
    if (budgetHold) {
      send({ type: "error", message: budgetHold });
      return;
    }
    // Enforce max turns from settings
    promptCount++;
    if (promptCount > optioSettings.maxTurns) {
      send({
        type: "error",
        message: `Conversation limit reached (${optioSettings.maxTurns} turns). Please start a new session.`,
      });
      return;
    }

    const claim = await claimSessionTurn(sessionId, requestId, prompt);
    if (!claim.accepted) {
      send({ type: "error", message: claim.reason });
      return;
    }
    onAccepted?.(claim.turn.id);
    persist(
      {
        sessionId,
        content: prompt,
        stream: "stdin",
        logType: "user_message",
        metadata: { requestId },
      },
      "user message",
    );
    broadcast({ type: "user_message", content: prompt, requestId });
    // Another tab may have advanced the conversation since this socket opened.
    isProcessing = true;
    let completed = false;
    broadcast({ type: "status", status: "thinking" });

    // Append custom system prompt from settings if configured
    let fullPrompt = prompt;
    if (optioSettings.systemPrompt) {
      fullPrompt = `${prompt}\n\n[Additional instructions: ${optioSettings.systemPrompt}]`;
    }

    try {
      agentSessionId = (await getSession(sessionId))?.agentSessionId ?? null;
      const result = await executeTurn(fullPrompt, agentSessionId, claim.turn.id);
      completed = result.completed;
      const { fallback } = result;
      // An interrupted turn is over; don't start a second exec then.
      if (fallback && !result.interrupted) {
        await forgetAgentSessionId("resume_failed");
        emitEntry({
          taskId: sessionId,
          timestamp: new Date().toISOString(),
          type: "info",
          content:
            "Previous conversation could not be resumed (the workspace was likely recreated); starting a fresh conversation.",
        });
        completed = (await executeTurn(fullPrompt, null, claim.turn.id)).completed;
      }
    } catch (err) {
      log.error({ err }, "Failed to run claude prompt in session");
      broadcast({ type: "error", message: "Failed to execute agent prompt" });
    } finally {
      await persistChain;
      await finishSessionTurn(claim.turn.id, completed).catch((err) =>
        log.error({ err }, "Unable to settle turn; receipt remains locked for recovery"),
      );
      isProcessing = false;
      execSession = null;
      broadcast({ type: "status", status: "idle", recovery: completed ? "live" : "resumable" });
    }
  };

  return {
    runPrompt,
    get model() {
      return currentModel;
    },
    get processing() {
      return isProcessing;
    },
    costUsd: cumulativeCost,
    settings: optioSettings,
    setModel(model: string) {
      currentModel = model;
    },
  };
}

/** Build auth environment variables for the claude process in the pod. */
async function buildAuthEnv(
  log: { warn: (obj: any, msg: string) => void },
  userId?: string | null,
  workspaceId?: string | null,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  try {
    const { retrieveSecret, retrieveSecretWithFallback } = await import("./secret-service.js");
    const authMode = (await retrieveSecret("CLAUDE_AUTH_MODE").catch(() => null)) as string | null;

    if (authMode === "api-key") {
      const apiKey = await retrieveSecretWithFallback(
        "ANTHROPIC_API_KEY",
        "global",
        workspaceId,
        userId,
      ).catch(() => null);
      if (apiKey) {
        env.ANTHROPIC_API_KEY = apiKey as string;
      }
    } else if (authMode === "max-subscription") {
      const { getClaudeAuthToken } = await import("./auth-service.js");
      const result = getClaudeAuthToken();
      if (result.available && result.token) {
        env.CLAUDE_CODE_OAUTH_TOKEN = result.token;
      }
    } else if (authMode === "oauth-token") {
      const token = await retrieveSecretWithFallback(
        "CLAUDE_CODE_OAUTH_TOKEN",
        "global",
        workspaceId,
        userId,
      ).catch(() => null);
      if (token) {
        env.CLAUDE_CODE_OAUTH_TOKEN = token as string;
      }
    }
  } catch (err) {
    log.warn({ err }, "Failed to build auth env for session chat");
  }

  return env;
}

/**
 * Add one turn's cost to the session's stored total. The increment happens in
 * SQL, so connections that overlap (a reconnect racing the old socket, two
 * tabs) all add rather than overwrite each other's totals.
 */
export async function recordSessionUsage(turnId: string, sessionId: string, usage: AgentResult) {
  await db.transaction(async (tx) => {
    const [turn] = await tx
      .select()
      .from(sessionChatTurns)
      .where(eq(sessionChatTurns.id, turnId))
      .for("update");
    if (!turn || turn.sessionId !== sessionId) return;
    const prior = turn.usage ?? {};
    const cost = usage.costUsd ?? null;
    const addsCost = cost != null && cost > Number(prior.costUsd ?? 0);
    await tx
      .update(sessionChatTurns)
      .set({
        usage: {
          ...prior,
          ...(cost != null
            ? { costUsd: Math.max(cost, Number(prior.costUsd ?? 0)), costBasis: "reported" }
            : {}),
          ...(usage.inputTokens != null
            ? { inputTokens: Math.max(usage.inputTokens, Number(prior.inputTokens ?? 0)) }
            : {}),
          ...(usage.outputTokens != null
            ? { outputTokens: Math.max(usage.outputTokens, Number(prior.outputTokens ?? 0)) }
            : {}),
          cacheReadTokens: Math.max(usage.cacheReadTokens ?? 0, Number(prior.cacheReadTokens ?? 0)),
          cacheWriteTokens: Math.max(
            usage.cacheWriteTokens ?? 0,
            Number(prior.cacheWriteTokens ?? 0),
          ),
          model: usage.model ?? prior.model ?? null,
        },
      })
      .where(eq(sessionChatTurns.id, turnId));
    if (addsCost)
      await tx
        .update(interactiveSessions)
        .set({
          costUsd: sql<string>`trim_scale(COALESCE(NULLIF(${interactiveSessions.costUsd},''),'0')::numeric + GREATEST(0,${String(cost)}::numeric-${String(prior.costUsd ?? 0)}::numeric))::text`,
        })
        .where(eq(interactiveSessions.id, sessionId));
  });
}

/** The stored row for one agent chat event. */
function chatEventRow(
  sessionId: string,
  entry: import("@optio/shared").AgentLogEntry,
): Parameters<typeof appendSessionChatEvent>[0] {
  return {
    sessionId,
    content: entry.content,
    logType: entry.type,
    metadata: entry.metadata,
    timestamp: entry.timestamp ? new Date(entry.timestamp) : undefined,
  };
}
