import { z } from "zod";

/**
 * Interactive session, PR review draft, and issue domain schemas.
 *
 * Interactive sessions are long-lived workspaces that pair a terminal with
 * an agent chat. Review drafts are the output of the PR review agent,
 * stored in the DB between "created" and "submitted" states. Issue shapes
 * come from the GitHub / GitLab ticket providers and are intentionally
 * loose (`.passthrough()`) because different providers emit different
 * enrichment fields.
 */

export const InteractiveSessionSchema = z
  .object({
    id: z.string(),
    repoUrl: z.string(),
    userId: z.string().nullable(),
    worktreePath: z.string().nullable(),
    branch: z.string().describe("Branch the session has checked out"),
    state: z.string().describe("`active` | `ended`"),
    podId: z.string().nullable().describe("Pod ID backing this session"),
    costUsd: z.string().nullable().describe("Aggregate cost in USD (decimal string)"),
    workspaceId: z.string().nullable(),
    createdAt: z.date(),
    endedAt: z.date().nullable(),
  })
  .passthrough()
  .describe("Interactive session — persistent terminal + agent workspace");

export const SessionModelConfigSchema = z
  .object({
    claudeModel: z.string(),
    availableModels: z.array(z.string()),
  })
  .passthrough()
  .describe("Repo-configured Claude model + available choices");

export const SessionPrSchema = z
  .object({
    id: z.string(),
    sessionId: z.string(),
    prUrl: z.string(),
    prNumber: z.number().int(),
    createdAt: z.date(),
  })
  .passthrough()
  .describe("Pull request opened during a session");

export const SessionChatEventSchema = z
  .object({
    id: z.string(),
    sessionId: z.string(),
    stream: z.string().describe("stdout | stderr | stdin (user message)"),
    content: z.string(),
    logType: z
      .string()
      .nullable()
      .describe(
        "Parsed log category: text | tool_use | tool_result | thinking | system | error | info | user_message",
      ),
    metadata: z.record(z.unknown()).nullable(),
    timestamp: z.union([z.date(), z.string()]),
  })
  .passthrough()
  .describe("A single persisted session-chat event (one parsed agent log entry).");

export const ReviewDraftSchema = z
  .object({
    id: z.string(),
    taskId: z.string().nullable(),
    prUrl: z.string(),
    prNumber: z.number().int(),
    repoOwner: z.string(),
    repoName: z.string(),
    headSha: z.string(),
    state: z.string().describe("`waiting_ci` | `drafting` | `ready` | `submitted` | `stale`"),
    verdict: z.string().nullable().describe("`approve` | `request_changes` | `comment` | null"),
    summary: z.string().nullable(),
    fileComments: z.array(z.record(z.unknown())).nullable(),
    origin: z.string().describe("`manual` | `auto`").optional(),
    userEngaged: z.boolean().optional(),
    autoSubmitted: z.boolean().optional(),
    submittedAt: z.union([z.date(), z.string()]).nullable(),
    createdAt: z.union([z.date(), z.string()]),
    updatedAt: z.union([z.date(), z.string()]),
  })
  .passthrough()
  .describe("A PR review draft — output of the review agent, pre-submission");

export const PullRequestSummarySchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    number: z.number().int(),
    title: z.string(),
    url: z.string(),
    state: z.string(),
    author: z.string().nullable().optional(),
  })
  .passthrough()
  .describe("Lightweight PR summary as returned by list endpoints");

export const PrStatusSchema = z
  .object({
    checks: z.string().nullable().optional(),
    review: z.string().nullable().optional(),
    mergeable: z.boolean().nullable().optional(),
  })
  .passthrough()
  .describe("Aggregate PR status from the git platform");

export const MergeResultSchema = z
  .object({
    merged: z.boolean(),
    sha: z.string().optional(),
  })
  .passthrough()
  .describe("Result of merging a PR");

export const IssueSummarySchema = z
  .record(z.unknown())
  .describe(
    "Issue summary from a ticket provider. Shape varies by provider but " +
      "typically includes: id, number, title, body, state, url, labels, " +
      "hasOptioLabel, author, assignee, repo, createdAt, updatedAt, optioTask.",
  );
