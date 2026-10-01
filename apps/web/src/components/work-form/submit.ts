import {
  cleanWorkSettings,
  getProviderCatalog,
  providerForAgentType,
  withoutPrSettings,
  type WorkFormDefaults,
  type WorkSettings,
  type WorkSpec,
} from "@optio/shared";
import { api } from "@/lib/api-client";
import { defaultAgentsMd } from "@/lib/persistent-agent-defaults";
import {
  deriveKind,
  effectiveOwner,
  isEventWhen,
  isLocal,
  isPodWork,
  asksForPrompt,
  prSettingsApply,
  slugify,
  takesOwner,
  TERMINAL,
  type WorkDraft,
} from "./model";
import { detailHref, type EditTarget } from "./load";

/** Where the browser goes once the session exists. */
export interface Created {
  kind: ReturnType<typeof deriveKind>;
  href: string;
  toast: string;
}

/**
 * The trigger row a draft asks for, if any — the same shape whatever kind
 * of row it attaches to: a schedule, a webhook, a ticket filter, or a
 * GitHub / Slack / Linear event.
 */
function triggerFor(d: WorkDraft) {
  if (isEventWhen(d.when)) return { type: d.when, config: d.event.config, enabled: true as const };
  const t = d.trigger;
  if (t.type === "manual") return null;
  const config: Record<string, unknown> =
    t.type === "schedule"
      ? { cronExpression: t.cronExpression!.trim() }
      : t.type === "webhook"
        ? { path: t.webhookPath }
        : {
            source: t.ticketSource ?? "github",
            ...(t.ticketLabels?.length ? { labels: t.ticketLabels } : {}),
          };
  return { type: t.type, config, enabled: true as const };
}

/** The run-name template, or null for "runs take the definition's name". */
function runNameFor(d: WorkDraft): string | null {
  return d.runName.trim() || null;
}

/** Only the options the user actually set (blank selects mean "default"). */
function setOptions(d: WorkDraft): Record<string, string | boolean> | null {
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(d.agentOptions)) {
    if (v === "" || v === undefined) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * What a successful create remembers as your New work form settings: the
 * runtime and the options actually submitted for it. Null for a terminal.
 */
export function workDefaultsFrom(d: WorkDraft): WorkFormDefaults | null {
  if (d.runtime === TERMINAL) return null;
  return { runtime: d.runtime, agentOptions: { [d.runtime]: setOptions(d) ?? {} } };
}

/** Fire-and-forget: never blocks or fails the submit. */
export function rememberWorkDefaults(d: WorkDraft): void {
  const body = workDefaultsFrom(d);
  if (!body) return;
  try {
    void api.putWorkDefaults(body).catch(() => {});
  } catch {
    // ignore
  }
}

/**
 * Who the row belongs to and what its pod may read: every Task, Job and
 * agent carries an owner (a machine run is always "me"); pod work also
 * carries the picked secrets (an array for new work, possibly empty; a
 * legacy row that never picked keeps null) and its environment settings.
 */
export function ownership(d: WorkDraft): {
  owner?: "workspace" | "me";
  podSecrets?: string[] | null;
  settings?: WorkSettings | null;
} {
  if (!takesOwner(d)) return {};
  return {
    owner: effectiveOwner(d),
    ...(isPodWork(d)
      ? {
          podSecrets: d.podSecrets,
          // Only what changes the defaults; PR follow-through only where a PR opens.
          settings: prSettingsApply(d)
            ? cleanWorkSettings(d.settings)
            : withoutPrSettings(cleanWorkSettings(d.settings)),
        }
      : {}),
  };
}

/** The model the draft picked for its runtime, for rows that carry just a model. */
export function pickedModel(d: WorkDraft): string | undefined {
  if (d.runtime === TERMINAL) return undefined;
  const catalog = getProviderCatalog(providerForAgentType(d.runtime));
  const v = catalog ? d.agentOptions[catalog.modelField] : undefined;
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Only the work's own create can 409 on its name (or a webhook path, which a new name doesn't fix). */
function isNameClash(err: unknown): boolean {
  const e = err as { status?: number; details?: string } | null;
  return e?.status === 409 && e?.details === "name_taken";
}

/**
 * The draft as the five attributes `/api/work` takes. The server derives
 * the kind from them (the same rule as `deriveKind`) and creates the row,
 * its trigger, and — for a Job started now — its first run, together.
 */
export function specFor(d: WorkDraft, ctx: { repoUrl: string; name: string }): WorkSpec {
  const kind = deriveKind(d);
  const local = isLocal(d);
  const trigger = triggerFor(d);
  const options = setOptions(d);
  return {
    name: ctx.name,
    description: d.description.trim() || null,
    when: trigger ? { type: trigger.type, config: trigger.config } : { type: "manual" },
    where: {
      runTarget: d.location.runTarget,
      // A pod session is always in a repo pod; otherwise the repo is "with repo".
      repoUrl: (d.withRepo || kind === "pod-session") && ctx.repoUrl ? ctx.repoUrl : null,
      // On a machine, a base branch is also what says "on a new branch".
      repoBranch: d.withRepo ? d.repoBranch || "main" : null,
      localHostId: local ? d.location.localHostId || null : null,
      localDir: local ? d.location.localDir || null : null,
    },
    who: {
      runtime: d.runtime === TERMINAL ? null : d.runtime,
      agentOptions: d.runtime === TERMINAL ? null : options,
      model: pickedModel(d) ?? null,
    },
    // A terminal that waits for you opens a shell: it has nothing to run.
    what: { prompt: asksForPrompt(d) ? d.prompt.trim() : "", runTitle: runNameFor(d) },
    then: d.then,
    mergeWhenReady: d.mergeWhenReady,
    maxRetries: d.maxRetries,
    priority: d.priority,
    ...(kind === "repo-task" && d.dependsOn.length ? { dependsOn: d.dependsOn } : {}),
    ...(kind === "persistent-agent"
      ? {
          agent: {
            slug: d.agent.slug.trim() || slugify(ctx.name),
            systemPrompt: d.agent.systemPrompt || null,
            agentsMd: d.agent.agentsMd || defaultAgentsMd(),
            podLifecycle: d.agent.podLifecycle,
          },
        }
      : {}),
    ...ownership(d),
  };
}

/** The toast a kind gets once it exists. */
function toastFor(d: WorkDraft, kind: Created["kind"], name: string, started: boolean): string {
  switch (kind) {
    case "repo-task":
      return d.then === "until-merged"
        ? `${name} started — it will work the PR until it merges`
        : `${name} started — it will open a PR`;
    case "local-terminal":
    case "pod-session":
      return `${name} opened`;
    case "persistent-agent":
      return `${name} created`;
    default:
      return started ? `${name} started` : `${name} saved`;
  }
}

/**
 * Create the work the draft describes (`POST /api/work`). Jobs, scheduled
 * Tasks, and agents have unique names, and "Session N" is only a count: on
 * a name clash keep the user's own name as an error, but bump an automatic
 * one and try again.
 */
export async function createWork(
  d: WorkDraft,
  ctx: { repoUrl: string; autoName: string },
): Promise<Created> {
  const auto = !d.name.trim();
  for (let attempt = 1; ; attempt++) {
    const name =
      auto && attempt > 1 ? `${ctx.autoName} (${attempt})` : d.name.trim() || ctx.autoName;
    try {
      const created = await api.createWork(specFor(d, { repoUrl: ctx.repoUrl, name }));
      return {
        kind: created.kind,
        href: created.run?.href ?? created.href,
        toast: toastFor(d, created.kind, name, !!created.run),
      };
    } catch (err) {
      if (!auto || !isNameClash(err) || attempt >= 5) throw err;
    }
  }
}

// ── Editing ──────────────────────────────────────────────────────────────────

/**
 * Save an edited draft back onto its definition (`PATCH /api/work/:id`).
 * The kind is fixed (the form refuses answers that would change it, and so
 * does the server); the trigger the form edits follows the When answer in
 * the same transaction. Returns where to go next.
 */
export async function updateWork(
  target: EditTarget,
  d: WorkDraft,
  ctx: { repoUrl: string },
): Promise<Created> {
  const name = d.name.trim() || target.row.name;
  await api.updateWork(target.id, specFor(d, { repoUrl: ctx.repoUrl, name }));
  return { kind: target.kind, href: detailHref(target), toast: `${name} saved` };
}
