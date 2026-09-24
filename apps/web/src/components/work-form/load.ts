import { getProviderCatalog, providerForAgentType } from "@optio/shared";
import { api } from "@/lib/api-client";
import { runLocationFromRow } from "@/components/run-location-picker";
import type { TriggerConfig } from "@/components/trigger-selector";
import {
  EMPTY_DRAFT,
  TERMINAL,
  isEventWhen,
  normalize,
  type EventTrigger,
  type WorkDraft,
  type WorkKind,
  type WhenType,
} from "./model";

/**
 * A saved session opened for editing: the kind its row lives in (fixed for
 * the edit), the row itself, and its trigger. Only the kinds that persist a
 * definition — a scheduled Task, a Job, a Local automation — are editable;
 * one-shot runs, terminals, and agents have their own pages.
 */
export type EditableKind = Extract<WorkKind, "repo-blueprint" | "standalone" | "local-blueprint">;

export interface EditTarget {
  id: string;
  kind: EditableKind;
  row: any;
  /** The trigger the form edits (the first enabled one), if the row has any. */
  trigger: any | null;
  /** Every trigger on the row, so a save can retire the ones it replaces. */
  triggers: any[];
  draft: WorkDraft;
}

export const isEditableKind = (k: string): k is EditableKind =>
  k === "repo-blueprint" || k === "standalone" || k === "local-blueprint";

/** The page about the row — its stats, triggers, and prior runs. */
export function detailHref(target: Pick<EditTarget, "id" | "kind">): string {
  switch (target.kind) {
    case "repo-blueprint":
      return `/tasks/scheduled/${target.id}`;
    case "standalone":
      return `/jobs/${target.id}`;
    case "local-blueprint":
      return `/local/automations/${target.id}`;
  }
}

/** A stored trigger row, back to the form's When answer. */
export function whenFromTrigger(
  trigger: any | null,
): Pick<WorkDraft, "when" | "trigger" | "event"> {
  const base = { when: "manual" as WhenType, trigger: { type: "manual" } as TriggerConfig };
  if (!trigger) return { ...base, event: EMPTY_DRAFT.event };
  const c = (trigger.config ?? {}) as Record<string, unknown>;
  const type = String(trigger.type) as WhenType;
  if (isEventWhen(type)) {
    const event: EventTrigger = { type, config: { ...c } };
    return { when: type, trigger: { type: "manual" }, event };
  }
  switch (type) {
    case "schedule":
      return {
        ...base,
        when: "schedule",
        trigger: { type: "schedule", cronExpression: String(c.cronExpression ?? "") },
        event: EMPTY_DRAFT.event,
      };
    case "webhook":
      return {
        ...base,
        when: "webhook",
        trigger: { type: "webhook", webhookPath: String(c.path ?? "") },
        event: EMPTY_DRAFT.event,
      };
    case "ticket":
      return {
        ...base,
        when: "ticket",
        trigger: {
          type: "ticket",
          ticketSource: (c.source as TriggerConfig["ticketSource"]) ?? "github",
          ticketLabels: Array.isArray(c.labels) ? (c.labels as string[]) : [],
        },
        event: EMPTY_DRAFT.event,
      };
    default:
      return { ...base, event: EMPTY_DRAFT.event };
  }
}

/** The row's saved agent parameters, folding a legacy single `model` in. */
function optionsFromRow(runtime: string, row: any): WorkDraft["agentOptions"] {
  const out: WorkDraft["agentOptions"] = { ...(row.agentOptions ?? {}) };
  const catalog = runtime === TERMINAL ? null : getProviderCatalog(providerForAgentType(runtime));
  if (catalog && typeof row.model === "string" && row.model && out[catalog.modelField] == null) {
    out[catalog.modelField] = row.model;
  }
  return out;
}

/**
 * The draft a saved row is the point for — the inverse of `createWork`'s
 * branch for its kind. `normalize` then confirms the draft sits inside the
 * space, which it does for anything the form itself saved.
 */
export function draftFromRow(kind: EditableKind, row: any, trigger: any | null): WorkDraft {
  const when = whenFromTrigger(trigger);
  const common = {
    ...EMPTY_DRAFT,
    ...when,
    name: String(row.name ?? row.title ?? ""),
    description: String(row.description ?? ""),
  };
  switch (kind) {
    case "repo-blueprint":
      return normalize({
        ...common,
        // The form saves `title = name` when no run name is set.
        runName: row.title && row.title !== row.name ? String(row.title) : "",
        location: runLocationFromRow(row),
        withRepo: true,
        repoUrl: String(row.repoUrl ?? ""),
        repoBranch: String(row.repoBranch ?? "main"),
        runtime: String(row.agentType ?? "claude-code"),
        agentOptions: optionsFromRow(String(row.agentType ?? "claude-code"), row),
        prompt: String(row.prompt ?? ""),
        then: "exits",
        priority: typeof row.priority === "number" ? row.priority : EMPTY_DRAFT.priority,
        maxRetries: typeof row.maxRetries === "number" ? row.maxRetries : EMPTY_DRAFT.maxRetries,
      });
    case "standalone": {
      const runtime = String(row.agentRuntime ?? "claude-code");
      return normalize({
        ...common,
        runName: String(row.runTitle ?? ""),
        location: runLocationFromRow(row),
        withRepo: false,
        runtime,
        agentOptions: optionsFromRow(runtime, row),
        prompt: String(row.promptTemplate ?? ""),
        then: "exits",
        maxRetries: typeof row.maxRetries === "number" ? row.maxRetries : EMPTY_DRAFT.maxRetries,
      });
    }
    case "local-blueprint": {
      const interactive = row.sessionMode !== "headless";
      return normalize({
        ...common,
        runName: String(row.runTitle ?? ""),
        location: {
          runTarget: "local",
          localHostId: String(row.hostId ?? ""),
          localDir: String(row.dir ?? ""),
          localSessionMode: interactive ? "interactive" : "headless",
        },
        withRepo: !!row.baseBranch,
        repoUrl: String(row.repoUrl ?? ""),
        repoBranch: String(row.baseBranch ?? "main"),
        runtime: row.agent ? String(row.agent) : TERMINAL,
        agentOptions: row.agent ? { ...(row.agentOptions ?? {}) } : {},
        prompt: String(row.commandTemplate ?? ""),
        then: interactive ? "waits-for-me" : "exits",
      });
    }
  }
}

/** The trigger the form should show: the first enabled one, else the first. */
export function pickTrigger(triggers: any[]): any | null {
  return triggers.find((t) => t.enabled !== false) ?? triggers[0] ?? null;
}

/**
 * Resolve an id to something the form can edit. The unified `/api/tasks`
 * resolver covers scheduled Tasks and Jobs; Local automations live under
 * `/api/local/blueprints`. Anything else (a one-shot Task, a run) is not a
 * definition and has no edit form.
 */
export async function loadEditTarget(id: string): Promise<EditTarget> {
  const unified = await api.getTaskUnified(id).catch((err: { status?: number }) => {
    if (err?.status === 404) return null;
    throw err;
  });
  if (unified) {
    const kind = String(unified.task.type);
    if (!isEditableKind(kind)) {
      throw Object.assign(new Error("Only recurring sessions can be edited"), { status: 405 });
    }
    const { triggers } = await api.listTaskTriggers(id);
    const trigger = pickTrigger(triggers);
    return {
      id,
      kind,
      row: unified.task,
      trigger,
      triggers,
      draft: draftFromRow(kind, unified.task, trigger),
    };
  }
  const [{ blueprint }, { triggers }] = await Promise.all([
    api.getLocalBlueprint(id),
    api.listLocalBlueprintTriggers(id),
  ]);
  const trigger = pickTrigger(triggers);
  return {
    id,
    kind: "local-blueprint",
    row: blueprint,
    trigger,
    triggers,
    draft: draftFromRow("local-blueprint", blueprint, trigger),
  };
}
