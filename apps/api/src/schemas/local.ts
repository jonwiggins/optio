import { z } from "zod";

export const LocalHostDirSchema = z
  .object({
    path: z.string().describe("Absolute path on the host"),
    repoUrl: z.string().optional().describe("Detected git remote URL, when the dir is a repo"),
  })
  .describe("Allowlisted directory on a local host");

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
    }),
  ])
  .describe("What the daemon runs in the PTY");

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
    commandTemplate: z.string(),
    agent: z.enum(["claude-code", "codex", "cursor", "gemini", "opencode"]).nullable(),
    spawnMode: z.enum(["auto", "hold"]),
    enabled: z.boolean(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .describe("Reusable local terminal spec spawned by triggers");

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
