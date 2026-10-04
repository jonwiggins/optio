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
  /**
   * The row is someone else's private work: only they can change it (it
   * runs with their credentials), so the form opens read-only — what an
   * admin sees. `foreignOwnerName` names them (from the Work row).
   */
  foreignOwnerId: string | null;
  foreignOwnerName: string | null;
}

/**
 * A row's owner as the form's answer: null → the organization; you → "me";
 * someone else → "me" from their side, flagged so the form goes read-only.
 */
export function ownerFromRow(
  row: { ownerUserId?: string | null } | null | undefined,
  meId: string | null | undefined,
): { owner: WorkDraft["owner"]; foreignOwnerId: string | null } {
  const ownerId = row?.ownerUserId ?? null;
  if (!ownerId) return { owner: "workspace", foreignOwnerId: null };
  // Unknown viewer: leave it editable; the server refuses a non-owner save.
  return { owner: "me", foreignOwnerId: !meId || ownerId === meId ? null : ownerId };
}

/** The row's picked pod secrets; null when it predates picking. */
function podSecretsFromRow(row: any): string[] | null {
  return Array.isArray(row?.podSecrets) ? row.podSecrets.map(String) : null;
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
 * The draft a saved definition is the point for — the inverse of `specFor`.
 * One mapping for every kind: the stored row (`GET /api/work/:id`) names
 * each attribute once. `normalize` then confirms the draft sits inside the
 * space, which it does for anything the form itself saved.
 */
export function draftFromRow(row: any, trigger: any | null, meId?: string | null): WorkDraft {
  const kind = row.kind as EditableKind;
  const automation = kind === "local-blueprint";
  // No agent is a terminal: a command Job, or an automation's shell / command.
  // (Only a scheduled Task always has one — Claude Code for the oldest rows.)
  const runtime = row.agentType
    ? String(row.agentType)
    : kind === "repo-blueprint"
      ? "claude-code"
      : TERMINAL;
  const prompt = String(row.prompt ?? "");
  const interactive = row.localSessionMode !== "headless";
  const name = String(row.name ?? "");
  // Older forms saved `run title = name` when no run name was set.
  const runTitle = row.runTitle && row.runTitle !== name ? String(row.runTitle) : "";
  return normalize({
    ...EMPTY_DRAFT,
    ...whenFromTrigger(trigger),
    owner: ownerFromRow(row, meId).owner,
    podSecrets: podSecretsFromRow(row),
    settings: row.settings && typeof row.settings === "object" ? row.settings : {},
    name,
    description: String(row.description ?? ""),
    runName: runTitle,
    location: automation
      ? {
          runTarget: "local",
          localHostId: String(row.localHostId ?? ""),
          localDir: String(row.localDir ?? ""),
          localSessionMode: interactive ? "interactive" : "headless",
        }
      : runLocationFromRow(row),
    // A scheduled Task works in its repo; a Local automation with a base branch on a new branch.
    withRepo: kind === "repo-blueprint" || (automation && !!row.repoBranch),
    repoUrl: String(row.repoUrl ?? ""),
    repoBranch: String(row.repoBranch ?? "main"),
    runtime,
    agentOptions: runtime === TERMINAL ? {} : optionsFromRow(runtime, row),
    prompt,
    // A row saved with its own follow-through is "Works until merged". An
    // automation with no agent that runs a command is a command (it exits);
    // with none it opens a shell that waits for you.
    then: automation
      ? (runtime === TERMINAL ? !prompt.trim() : interactive)
        ? "waits-for-me"
        : "exits"
      : row.autoResume === true
        ? "until-merged"
        : "exits",
    mergeWhenReady: row.autoMerge !== false,
    priority: typeof row.priority === "number" ? row.priority : EMPTY_DRAFT.priority,
    maxRetries: typeof row.maxRetries === "number" ? row.maxRetries : EMPTY_DRAFT.maxRetries,
  });
}

/** The trigger the form should show: the first enabled one, else the first. */
export function pickTrigger(triggers: any[]): any | null {
  return triggers.find((t) => t.enabled !== false) ?? triggers[0] ?? null;
}

/**
 * Resolve an id to something the form can edit (`GET /api/work/:id`): a
 * saved definition — a scheduled Task, a Job, or a Local automation.
 * Anything else (a one-shot Task, a run, a session) is not a definition and
 * has no edit form.
 */
export async function loadEditTarget(id: string): Promise<EditTarget> {
  const meId = await Promise.resolve()
    .then(() => api.getCurrentUser())
    .then((r) => r.user.id)
    .catch(() => null);
  const { source, row, work } = await api.getWork(id);
  if (!isEditableKind(source)) {
    throw Object.assign(new Error("Only recurring sessions can be edited"), { status: 405 });
  }
  const { triggers } = await api.listWorkTriggers(id);
  const trigger = pickTrigger(triggers);
  // Automations live on your own machine; they are always yours.
  const foreignOwnerId =
    source === "local-blueprint" ? null : ownerFromRow(work, meId).foreignOwnerId;
  return {
    id,
    kind: source,
    row: work,
    trigger,
    triggers,
    draft: draftFromRow(work, trigger, meId),
    foreignOwnerId,
    foreignOwnerName: foreignOwnerId ? (row?.ownerName ?? null) : null,
  };
}
