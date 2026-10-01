import { z } from "zod";
import { WORK_VIEWS } from "@optio/shared";

/** One entry of the Work list — see `WorkRow` in @optio/shared. */
export const WorkRowSchema = z
  .object({
    key: z.string().describe("Unique across kinds: `task-<id>`, `terminal-<id>`, …"),
    source: z.enum([
      "repo-task",
      "repo-blueprint",
      "standalone",
      "local-blueprint",
      "local-terminal",
      "pod-session",
      "persistent-agent",
    ]),
    id: z.string().describe("Id of the underlying row"),
    href: z.string().describe("Web route the row opens"),
    name: z.string(),
    when: z.string().describe('What starts it ("now", "on a trigger", "messages", …)'),
    where: z.object({
      target: z.enum(["pod", "machine"]),
      detail: z.string().nullable(),
    }),
    who: z.string().describe('Agent runtime id, or "terminal"'),
    then: z.enum(["exits", "until-merged", "waits-for-me", "waits-for-messages"]),
    status: z.enum([
      "needs_you",
      "running",
      "queued",
      "waiting",
      "scheduled",
      "paused",
      "done",
      "failed",
    ]),
    statusLabel: z.string(),
    note: z.string().nullable(),
    prUrl: z.string().nullable(),
    lastActivity: z.string().nullable().describe("ISO-8601"),
    recurring: z.boolean().describe("A definition that spawns runs"),
    editHref: z.string().nullable(),
    spawned: z.boolean().describe("A run spawned from a definition"),
  })
  .describe("A piece of work projected onto When / Where / Who / Then + a status");

export const WorkViewSchema = z.enum(WORK_VIEWS as [string, ...string[]]);

export const WorkListQuerySchema = z.object({
  view: WorkViewSchema.optional().describe("Filter to one view of the Work list (default: all)"),
});

export const WorkListResponseSchema = z
  .object({ rows: z.array(WorkRowSchema) })
  .describe("Every piece of work the caller can see, needs-you first");

export const WorkDetailResponseSchema = z
  .object({
    source: WorkRowSchema.shape.source,
    row: WorkRowSchema,
    work: z.record(z.unknown()).describe("The native row from its backing table"),
  })
  .describe("A piece of work resolved by id across every kind");
