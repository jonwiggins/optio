import { z } from "zod";
import {
  WORK_SOURCES,
  WORK_STATUSES,
  WORK_THENS,
  WORK_VIEWS,
  type WorkCreated,
  type WorkEnvironmentOptions,
  type WorkSpec,
} from "@optio/shared";
import { AgentTypeSchema } from "./task.js";
import { WorkflowTriggerSchema } from "./workflow.js";

/** One entry of the Work list — see `WorkRow` in @optio/shared. */
export const WorkRowSchema = z
  .object({
    key: z.string().describe("Unique across kinds: `task-<id>`, `terminal-<id>`, …"),
    source: z.enum(WORK_SOURCES),
    id: z.string().describe("Id of the underlying row"),
    href: z.string().describe("Web route the row opens"),
    name: z.string(),
    when: z.string().describe('What starts it ("now", "on a trigger", "messages", …)'),
    where: z.object({
      target: z.enum(["pod", "machine"]),
      detail: z.string().nullable(),
    }),
    who: z.string().describe('Agent runtime id, or "terminal"'),
    then: z.enum(WORK_THENS),
    status: z.enum(WORK_STATUSES),
    statusLabel: z.string(),
    note: z.string().nullable(),
    prUrl: z.string().nullable(),
    prState: z.string().nullable().optional().describe("open | merged | closed, when known"),
    triggers: z
      .array(z.object({ type: z.string(), source: z.string().nullable().optional() }))
      .optional()
      .describe("What starts it (a definition) or started it (a run), one per type"),
    lastActivity: z.string().nullable().describe("ISO-8601"),
    orderAt: z
      .string()
      .nullable()
      .optional()
      .describe("What the list orders the row by when it isn't lastActivity (ISO-8601)"),
    recurring: z.boolean().describe("A definition that spawns runs"),
    editHref: z.string().nullable(),
    spawned: z.boolean().describe("A run spawned from a definition"),
  })
  .describe("A piece of work projected onto When / Where / Who / Then + a status");

export const WorkListQuerySchema = z.object({
  view: z
    .enum(WORK_VIEWS)
    .optional()
    .describe("Filter to one view of the Work list (default: all)"),
});

export const WorkListResponseSchema = z
  .object({ rows: z.array(WorkRowSchema) })
  .describe("Every piece of work the caller can see, needs-you first");

export const WorkDetailResponseSchema = z
  .object({
    source: WorkRowSchema.shape.source,
    row: WorkRowSchema,
    work: z
      .record(z.unknown())
      .describe(
        "The stored row: a work_definitions row (with `kind`) for scheduled Tasks, Jobs, and " +
          "Local automations; the task, terminal, session, or agent row otherwise",
      ),
  })
  .describe("A piece of work resolved by id across every kind");

// ── Writing work ────────────────────────────────────────────────────────────

const branch = z.string().regex(/^[a-zA-Z0-9._/-]+$/, "Invalid branch name");

const IdOverridesSchema = z
  .object({
    add: z.array(z.string().uuid()).max(200).optional(),
    remove: z.array(z.string().uuid()).max(200).optional(),
  })
  .describe("Ids added to the default set, and ids taken out of it");

/** What a piece of pod work changes about its agent environment — `WorkSettings`. */
const WorkSettingsSchema = z
  .object({
    connections: IdOverridesSchema.optional().describe(
      "Connections beyond the ones the repo's assignments give, or left out",
    ),
    mcpServers: IdOverridesSchema.optional().describe(
      "MCP servers beyond the workspace's and the repo's, or left out",
    ),
    skills: IdOverridesSchema.optional().describe(
      "Custom and marketplace skills beyond the workspace's and the repo's, or left out",
    ),
    setupCommands: z
      .string()
      .max(20_000)
      .nullable()
      .optional()
      .describe("Shell commands run in the work's directory before the agent starts"),
    review: z
      .object({ enabled: z.boolean(), trigger: z.enum(["on_pr", "on_ci_pass"]).optional() })
      .nullable()
      .optional()
      .describe("Repo work: a review even when the repo has none (work can't turn the repo's off)"),
    cautiousMode: z
      .boolean()
      .nullable()
      .optional()
      .describe("Repo work: draft PRs a person merges (true only; work can't turn the repo's off)"),
    maxAutoResumes: z
      .number()
      .int()
      .min(0)
      .max(100)
      .nullable()
      .optional()
      .describe("Repo work: resume the agent at most this many times (at most the repo's cap)"),
  })
  .describe("Changes to the repo's / workspace's agent environment; unset = the default");

/** Work described by its five attributes — mirrors `WorkSpec` in @optio/shared. */
export const WorkSpecSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    when: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("manual") }),
        z.object({
          type: z.enum(["schedule", "webhook", "ticket", "github", "slack", "linear"]),
          config: z.record(z.unknown()),
        }),
      ])
      .describe("What starts it: `manual` (now / on demand) or a trigger and its config"),
    where: z
      .object({
        runTarget: z.enum(["cluster", "local"]),
        repoUrl: z.string().url().nullable().optional(),
        repoBranch: branch.nullable().optional(),
        localHostId: z.string().uuid().nullable().optional(),
        localDir: z.string().min(1).max(1000).nullable().optional(),
      })
      .describe("An Optio pod or one of your machines, and the repo it works in, if any"),
    who: z
      .object({
        runtime: AgentTypeSchema.nullable().describe("Agent runtime; null = a plain terminal"),
        agentOptions: z
          .record(z.union([z.string(), z.boolean()]))
          .nullable()
          .optional(),
        model: z.string().max(200).nullable().optional(),
      })
      .describe("The agent and its parameters"),
    what: z
      .object({
        prompt: z.string().max(100_000),
        runTitle: z.string().max(200).nullable().optional(),
      })
      .describe("The prompt (a terminal's command) and what each run is called"),
    then: z.enum(WORK_THENS).describe("What happens when a turn ends"),
    mergeWhenReady: z.boolean().optional(),
    maxRetries: z.number().int().min(0).max(10).optional(),
    priority: z.number().int().min(1).max(1000).optional(),
    dependsOn: z.array(z.string().uuid()).optional(),
    agent: z
      .object({
        slug: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and hyphens only")
          .optional(),
        systemPrompt: z.string().nullable().optional(),
        agentsMd: z.string().nullable().optional(),
        podLifecycle: z.enum(["always-on", "sticky", "on-demand"]).optional(),
      })
      .optional()
      .describe("A persistent agent's identity and pod"),
    owner: z
      .enum(["workspace", "me"])
      .optional()
      .describe("The organization's, or yours (runs with your credentials)"),
    podSecrets: z
      .array(z.string().min(1).max(200))
      .max(100)
      .nullable()
      .optional()
      .describe("Pod work: the secrets its pod gets, by name"),
    settings: WorkSettingsSchema.nullable().optional(),
  })
  .describe("Work described by When / Where / Who / What / Then");

export const WorkEnvironmentQuerySchema = z
  .object({
    repoUrl: z.string().optional().describe("The repo the work runs in; unset = no repo"),
    agentType: z.string().optional().describe("The agent runtime (default claude-code)"),
    owner: z
      .enum(["workspace", "me"])
      .optional()
      .describe("Whose the work is: personal connections only reach their owner's work"),
  })
  .describe("The work the environment is for");

const WorkEnvironmentItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  detail: z.string().nullable().optional(),
  scope: z.string().describe('Where it comes from: "global", "repo", "assigned", …'),
  default: z.boolean().describe("On without any override"),
});

export const WorkEnvironmentResponseSchema = z
  .object({
    connections: z.array(WorkEnvironmentItemSchema),
    mcpServers: z.array(WorkEnvironmentItemSchema),
    skills: z.array(WorkEnvironmentItemSchema),
    repo: z
      .object({
        setupCommands: z.string().nullable(),
        reviewEnabled: z.boolean(),
        reviewTrigger: z.string().nullable(),
        cautiousMode: z.boolean(),
        maxAutoResumes: z.number().nullable(),
      })
      .nullable()
      .describe("The repo's own values the overrides start from"),
  })
  .describe("What a piece of pod work's agent could get, with the defaults marked");

export const WorkCreatedSchema = z
  .object({
    kind: WorkRowSchema.shape.source,
    id: z.string(),
    href: z.string().describe("The page about it"),
    run: z
      .object({ id: z.string(), href: z.string() })
      .optional()
      .describe("A Job started now: its first run"),
  })
  .describe("What was made");

export const WorkTriggersResponseSchema = z
  .object({ triggers: z.array(WorkflowTriggerSchema) })
  .describe("The triggers that start a piece of work");

export const WorkTriggerResponseSchema = z
  .object({ trigger: WorkflowTriggerSchema })
  .describe("One trigger");

export const WorkRunsResponseSchema = z
  .object({ runs: z.array(WorkRowSchema) })
  .describe("What a definition has started, newest first, as Work list rows");

// What the schema accepts is a `WorkSpec`, and what the route answers is a
// `WorkCreated` — fail the build if the shared types and the schemas drift.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _spec: WorkSpec = {} as z.infer<typeof WorkSpecSchema>;
const _created: Same<z.infer<typeof WorkCreatedSchema>, WorkCreated> = true;
const _environment: WorkEnvironmentOptions = {} as z.infer<typeof WorkEnvironmentResponseSchema>;
void _spec;
void _created;
void _environment;
