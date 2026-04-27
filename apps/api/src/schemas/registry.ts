import { ErrorResponseSchema } from "./common.js";
import {
  TaskSchema,
  EnrichedTaskSchema,
  TaskEventSchema,
  LogEntrySchema,
  TaskStatsSchema,
  TaskStateSchema,
  AgentTypeSchema,
  TaskActivitySubstateSchema,
  WorktreeStateSchema,
  TaskTypeSchema,
  TaskCommentSchema,
  TaskMessageSchema,
  TaskDependencySchema,
  SubtaskStatusSchema,
  ActivityItemSchema,
} from "./task.js";
import {
  WorkflowSchema,
  WorkflowRunSchema,
  WorkflowTriggerSchema,
  WorkflowRunLogEntrySchema,
  CronValidationResultSchema,
} from "./workflow.js";
import {
  InteractiveSessionSchema,
  SessionChatEventSchema,
  SessionModelConfigSchema,
  SessionPrSchema,
  ReviewDraftSchema,
  PullRequestSummarySchema,
  PrStatusSchema,
  MergeResultSchema,
  IssueSummarySchema,
} from "./session.js";
import {
  RepoSchema,
  WebhookSchema,
  WebhookDeliverySchema,
  McpServerSchema,
  SkillSchema,
  PromptTemplateSchema,
  SharedDirectorySchema,
  TicketProviderSchema,
  SlackConfigSchema,
} from "./integration.js";
import {
  WorkspaceSchema,
  WorkspaceMemberSchema,
  NotificationSubscriptionSchema,
  NotificationPreferencesSchema,
  CostAnalyticsSchema,
} from "./workspace.js";

/**
 * Central registry of named schemas surfaced as `components.schemas` in the
 * generated OpenAPI document.
 *
 * `@fastify/swagger` calls `createJsonSchemaTransformObject({ schemas })`
 * once and the resulting transform walks the final spec, replacing any
 * structurally-equal JSON fragment with a `$ref` pointer into
 * `components.schemas`. Names here become the keys of that components map.
 *
 * Add new named schemas as new route phases migrate. Keep names stable —
 * clients generated from the spec use them as TypeScript type identifiers.
 */
export const namedSchemas = {
  ErrorResponse: ErrorResponseSchema,
  Task: TaskSchema,
  EnrichedTask: EnrichedTaskSchema,
  TaskEvent: TaskEventSchema,
  LogEntry: LogEntrySchema,
  TaskStats: TaskStatsSchema,
  TaskState: TaskStateSchema,
  AgentType: AgentTypeSchema,
  TaskActivitySubstate: TaskActivitySubstateSchema,
  WorktreeState: WorktreeStateSchema,
  TaskType: TaskTypeSchema,
  TaskComment: TaskCommentSchema,
  TaskMessage: TaskMessageSchema,
  TaskDependency: TaskDependencySchema,
  SubtaskStatus: SubtaskStatusSchema,
  ActivityItem: ActivityItemSchema,
  Workflow: WorkflowSchema,
  WorkflowRun: WorkflowRunSchema,
  WorkflowTrigger: WorkflowTriggerSchema,
  WorkflowRunLogEntry: WorkflowRunLogEntrySchema,
  CronValidationResult: CronValidationResultSchema,
  InteractiveSession: InteractiveSessionSchema,
  SessionChatEvent: SessionChatEventSchema,
  SessionModelConfig: SessionModelConfigSchema,
  SessionPr: SessionPrSchema,
  ReviewDraft: ReviewDraftSchema,
  PullRequestSummary: PullRequestSummarySchema,
  PrStatus: PrStatusSchema,
  MergeResult: MergeResultSchema,
  IssueSummary: IssueSummarySchema,
  Repo: RepoSchema,
  Webhook: WebhookSchema,
  WebhookDelivery: WebhookDeliverySchema,
  McpServer: McpServerSchema,
  Skill: SkillSchema,
  PromptTemplate: PromptTemplateSchema,
  SharedDirectory: SharedDirectorySchema,
  TicketProvider: TicketProviderSchema,
  SlackConfig: SlackConfigSchema,
  Workspace: WorkspaceSchema,
  WorkspaceMember: WorkspaceMemberSchema,
  NotificationSubscription: NotificationSubscriptionSchema,
  NotificationPreferences: NotificationPreferencesSchema,
  CostAnalytics: CostAnalyticsSchema,
} as const;
