import { z } from "zod";
import {
  WORK_SOURCES,
  WORK_STATUSES,
  WORK_THENS,
  WORK_VIEWS,
  type WorkCreated,
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
    lastActivity: z.string().nullable().describe("ISO-8601"),
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
  })
  .describe("Work described by When / Where / Who / What / Then");

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
void _spec;
void _created;
