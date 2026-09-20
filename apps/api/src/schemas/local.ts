import { z } from "zod";

export const LocalHostDirSchema = z
  .object({
    path: z.string().describe("Absolute path on the host"),
    repoUrl: z.string().optional().describe("Detected git remote URL, when the dir is a repo"),
  })
  .describe("Allowlisted directory on a local host");

const AgentLimitWindowSchema = z.object({
  usedPercent: z.number(),
  windowMinutes: z.number().nullable(),
  resetsAt: z.string().nullable(),
});

export const LocalHostSchema = z
  .object({
    id: z.string(),
    userId: z.string().nullable(),
    workspaceId: z.string().nullable(),
    name: z.string(),
    hostname: z.string(),
    platform: z.string(),
    arch: z.string().nullable(),
    daemonVersion: z.string().nullable(),
    dirs: z.array(LocalHostDirSchema),
    agentLimits: z
      .object({
        codex: z
          .object({
            primary: AgentLimitWindowSchema.nullable(),
            secondary: AgentLimitWindowSchema.nullable(),
            planType: z.string().nullable(),
            observedAt: z.string(),
          })
          .optional(),
      })
      .nullable()
      .describe("Agent subscription limits the daemon read off the machine"),
    claudeCredentials: z
      .boolean()
      .optional()
      .describe(
        "The connected daemon can hand Optio a fresh Claude OAuth token from the machine's own Claude Code login (false while offline)",
      ),
    state: z.enum(["online", "offline"]),
    lastSeenAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .describe("A paired local machine running the Optio Local daemon");

export const LocalTerminalSpecSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("shell") }),
    z.object({ kind: z.literal("command"), command: z.string().min(1).max(4000) }),
    z.object({
      kind: z.literal("agent"),
      agent: z.enum(["claude-code", "codex", "cursor", "gemini", "opencode"]),
      prompt: z.string().max(100_000).optional(),
      mode: z
        .enum(["interactive", "headless"])
        .optional()
        .describe(
          "interactive (default): stay open for chat; headless: exit when the turn is done",
        ),
      resumeSessionId: z
        .string()
        .max(128)
        .optional()
        .describe("Resume this agent session (its own session id) instead of starting fresh"),
      model: z
        .string()
        .max(100)
        .optional()
        .describe("Model override passed to the agent CLI (--model / -m)"),
      baseBranch: z
        .string()
        .max(200)
        .optional()
        .describe(
          "Work on a new branch off this base and open a PR: the prompt is wrapped with the instructions",
        ),
    }),
  ])
  .describe("What the daemon runs in the PTY");

export const LocalTranscriptEntrySchema = z
  .object({
    seq: z.number().int(),
    role: z.enum(["user", "assistant", "tool"]),
    kind: z.enum(["text", "thinking", "tool_use", "tool_result"]),
    text: z.string(),
    detail: z.string().nullable().describe("tool_use: the full input as JSON (bounded)"),
    toolName: z.string().nullable(),
    toolUseId: z.string().nullable().describe("Pairs a tool_use with its tool_result"),
    isError: z.boolean(),
    at: z.string().nullable(),
  })
  .describe("One entry of an agent session's conversation, distilled from the agent's transcript");

export const LocalTerminalSchema = z
  .object({
    id: z.string(),
    hostId: z.string(),
    userId: z.string().nullable(),
    workspaceId: z.string().nullable(),
    title: z.string(),
    dir: z.string(),
    command: z.string().nullable(),
    spec: z.record(z.unknown()),
    state: z.enum(["pending", "launching", "running", "exited", "error"]),
    pendingReason: z.string().nullable(),
    exitCode: z.number().nullable(),
    errorMessage: z.string().nullable(),
    attentionState: z.enum(["working", "needs_you", "idle"]),
    attentionReason: z.string().nullable(),
    spawnedBy: z.string(),
    blueprintId: z.string().nullable(),
    triggerId: z.string().nullable(),
    ticketSource: z.string().nullable(),
    ticketExternalId: z.string().nullable(),
    ticketUrl: z.string().nullable(),
    agentSessionId: z
      .string()
      .nullable()
      .describe("The agent CLI's own session id, once its hooks reported it (resumable)"),
    workflowRunId: z
      .string()
      .nullable()
      .optional()
      .describe("Job run this terminal executes (spawnedBy = job), if any"),
    taskId: z
      .string()
      .nullable()
      .optional()
      .describe("Repo Task this terminal executes (spawnedBy = task), if any"),
    preview: z.string().nullable(),
    links: z
      .array(
        z.object({
          url: z.string(),
          kind: z.enum(["pr", "issue", "ref"]),
          provider: z.enum(["github", "gitlab", "linear", "jira"]),
          label: z.string(),
        }),
      )
      .describe("PR / ticket links seen in the output"),
    usage: z
      .object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        cacheReadTokens: z.number(),
        cacheWriteTokens: z.number(),
        turns: z.number(),
        model: z.string().nullable(),
        costUsd: z.number().nullable(),
        updatedAt: z.string(),
      })
      .nullable()
      .describe("Token / cost totals summed from the agent's transcript (agent spawns only)"),
    costUsd: z.string().nullable(),
    lastActivityAt: z.date().nullable(),
    snoozedUntil: z
      .date()
      .nullable()
      .describe('"Later": out of the needs-you queue until this time'),
    createdAt: z.date(),
    updatedAt: z.date(),
    startedAt: z.date().nullable(),
    endedAt: z.date().nullable(),
  })
  .describe("A terminal session on a local host");

export const LocalBlueprintSchema = z
  .object({
    id: z.string(),
    userId: z.string().nullable(),
    workspaceId: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    hostId: z.string().nullable(),
    dir: z.string().nullable(),
    repoUrl: z.string().nullable(),
    baseBranch: z
      .string()
      .nullable()
      .describe("Agent spawns work on a new branch off this base and open a PR; null = as-is"),
    commandTemplate: z.string(),
    promptTemplateId: z
      .string()
      .nullable()
      .describe(
        "Saved prompt (Prompts library) used as the agent prompt instead of commandTemplate",
      ),
    agent: z.enum(["claude-code", "codex", "cursor", "gemini", "opencode"]).nullable(),
    spawnMode: z.enum(["auto", "hold"]),
    sessionMode: z
      .enum(["interactive", "headless"])
      .describe("Agent spawns: stay open for chat, or exit when the turn is done"),
    enabled: z.boolean(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .describe("Local automation: a reusable terminal / agent spec spawned by triggers");

export const LocalTriggerSchema = z
  .object({
    id: z.string(),
    targetType: z.string(),
    targetId: z.string(),
    type: z.string(),
    config: z.record(z.unknown()).nullable(),
    paramMapping: z.record(z.unknown()).nullable(),
    enabled: z.boolean(),
    lastFiredAt: z.date().nullable(),
    nextFireAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .describe("Trigger attached to a local blueprint");
