import { getProviderCatalog, providerForAgentType } from "@optio/shared";
import { api } from "@/lib/api-client";
import { runLocationPayload } from "@/components/run-location-picker";
import { defaultAgentsMd } from "@/lib/persistent-agent-defaults";
import { deriveKind, isEventWhen, slugify, TERMINAL, type WorkDraft } from "./model";
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

/** The model the draft picked for its runtime, for rows that carry just a model. */
export function pickedModel(d: WorkDraft): string | undefined {
  if (d.runtime === TERMINAL) return undefined;
  const catalog = getProviderCatalog(providerForAgentType(d.runtime));
  const v = catalog ? d.agentOptions[catalog.modelField] : undefined;
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Create the blueprint row, then its trigger. A rejected trigger (the API
 * validates event configs) deletes the row again so nothing half-made is
 * left behind, and the error surfaces to the form.
 */
async function withTrigger<T>(
  create: () => Promise<T>,
  attach: (row: T) => Promise<unknown>,
  discard: (row: T) => Promise<unknown>,
): Promise<T> {
  const row = await create();
  try {
    await attach(row);
  } catch (err) {
    await discard(row).catch(() => {});
    // The row was made; a rejected trigger is never a name clash.
    throw markNotNameClash(err);
  }
  return row;
}

/** Only the row's own create can 409 on its name; anything after it must not be retried as one. */
const NOT_NAME_CLASH = Symbol("notNameClash");
function markNotNameClash(err: unknown): unknown {
  if (err && typeof err === "object") (err as Record<symbol, boolean>)[NOT_NAME_CLASH] = true;
  return err;
}
function isNameClash(err: unknown): boolean {
  const e = err as { status?: number; [NOT_NAME_CLASH]?: boolean } | null;
  return e?.status === 409 && !e?.[NOT_NAME_CLASH];
}

/**
 * Turn a draft into the row(s) its kind needs. Each branch calls the same
 * service the dedicated form for that kind calls today, so nothing about how
 * a Task, Job, automation, terminal, or agent runs changes — only where you
 * make it.
 */
export async function createWork(
  d: WorkDraft,
  ctx: { repoUrl: string; autoName: string },
): Promise<Created> {
  // Jobs, scheduled Tasks, and agents have unique names per workspace, and
  // "Session N" is only a count: on a name clash keep the user's own name
  // as an error, but bump an automatic one and try again.
  const auto = !d.name.trim();
  for (let attempt = 1; ; attempt++) {
    const name =
      auto && attempt > 1 ? `${ctx.autoName} (${attempt})` : d.name.trim() || ctx.autoName;
    try {
      return await createOnce(d, { ...ctx, name });
    } catch (err) {
      if (!auto || !isNameClash(err) || attempt >= 5) throw err;
    }
  }
}

async function createOnce(d: WorkDraft, ctx: { repoUrl: string; name: string }): Promise<Created> {
  const kind = deriveKind(d);
  const { name } = ctx;
  const runName = runNameFor(d);
  const prompt = d.prompt.trim();
  const trigger = triggerFor(d);
  const location = runLocationPayload(d.location);
  const options = setOptions(d);
  const model = pickedModel(d);
  const { repoUrl } = ctx;

  switch (kind) {
    case "repo-task": {
      const { task } = await api.createTaskUnified({
        type: "repo-task",
        title: name,
        prompt,
        description: d.description || undefined,
        agentType: d.runtime,
        maxRetries: d.maxRetries,
        priority: d.priority,
        repoUrl,
        repoBranch: d.repoBranch,
        ...(options ? { metadata: { agentOptions: options } } : {}),
        ...(d.dependsOn.length ? { dependsOn: d.dependsOn } : {}),
        ...location,
      });
      return { kind, href: `/tasks/${task.id}`, toast: `${name} started — it will open a PR` };
    }

    case "repo-blueprint": {
      const task = await withTrigger(
        async () =>
          (
            await api.createTaskUnified({
              type: "repo-blueprint",
              title: runName ?? name,
              name,
              prompt,
              description: d.description || undefined,
              agentType: d.runtime,
              agentOptions: options,
              maxRetries: d.maxRetries,
              priority: d.priority,
              repoUrl,
              repoBranch: d.repoBranch,
              enabled: true,
              ...location,
            })
          ).task,
        (t) => (trigger ? api.createTaskTrigger(t.id, trigger) : Promise.resolve()),
        (t) => api.deleteTaskConfig(t.id),
      );
      return { kind, href: `/tasks/scheduled/${task.id}`, toast: `${name} saved` };
    }

    case "standalone": {
      const task = await withTrigger(
        async () =>
          (
            await api.createTaskUnified({
              type: "standalone",
              title: name,
              name,
              ...(runName ? { runTitle: runName } : {}),
              prompt,
              description: d.description || undefined,
              agentType: d.runtime,
              ...(model ? { model } : {}),
              agentOptions: options,
              maxRetries: d.maxRetries,
              enabled: true,
              ...location,
            })
          ).task,
        (t) => (trigger ? api.createTaskTrigger(t.id, trigger) : Promise.resolve()),
        (t) => api.deleteWorkflow(t.id),
      );
      if (trigger) return { kind, href: `/jobs/${task.id}`, toast: `${name} saved` };
      const run = await api.createTaskRun(task.id).catch((err) => {
        throw markNotNameClash(err);
      });
      return { kind, href: `/jobs/${task.id}/runs/${run.runId}`, toast: `${name} started` };
    }

    case "local-blueprint": {
      const blueprint = await withTrigger(
        async () =>
          (
            await api.createLocalBlueprint({
              name,
              description: d.description || undefined,
              hostId: d.location.localHostId,
              dir: d.location.localDir,
              ...(d.withRepo && repoUrl ? { repoUrl } : {}),
              // "New branch": the spawn wraps the prompt with branch + PR
              // instructions off this base.
              ...(d.withRepo ? { baseBranch: d.repoBranch || "main" } : {}),
              commandTemplate: prompt,
              ...(runName ? { runTitle: runName } : {}),
              agent: d.runtime === TERMINAL ? null : (d.runtime as "claude-code"),
              spawnMode: "auto",
              sessionMode: d.then === "waits-for-me" ? "interactive" : "headless",
            })
          ).blueprint,
        (b) => (trigger ? api.createLocalBlueprintTrigger(b.id, trigger) : Promise.resolve()),
        (b) => api.deleteLocalBlueprint(b.id),
      );
      return { kind, href: `/local/automations/${blueprint.id}`, toast: `${name} saved` };
    }

    case "local-terminal": {
      const { terminal } = await api.createLocalTerminal({
        hostId: d.location.localHostId,
        dir: d.location.localDir,
        title: name,
        spec:
          d.runtime === TERMINAL
            ? { kind: "shell" }
            : {
                kind: "agent",
                agent: d.runtime,
                ...(prompt ? { prompt } : {}),
                ...(model ? { model } : {}),
                // "New branch": the server wraps the prompt with branch + PR
                // instructions off this base.
                ...(d.withRepo ? { baseBranch: d.repoBranch || "main" } : {}),
              },
      });
      return { kind, href: `/local/${terminal.id}`, toast: `${name} opened` };
    }

    case "pod-session": {
      // A pod session is a terminal plus a Claude Code chat in a repo pod; the
      // runtime is fixed and the first message is typed in the session, so
      // only the repo and the name travel.
      const { session } = await api.createSession({ repoUrl, title: name });
      return { kind, href: `/sessions/${session.id}`, toast: `${name} opened` };
    }

    case "persistent-agent": {
      const agent = await withTrigger(
        async () =>
          (
            await api.createPersistentAgent({
              slug: d.agent.slug.trim() || slugify(name),
              name,
              description: d.description || undefined,
              agentRuntime: d.runtime,
              model: model ?? null,
              agentOptions: options,
              systemPrompt: d.agent.systemPrompt || null,
              agentsMd: d.agent.agentsMd || defaultAgentsMd(),
              initialPrompt: prompt,
              podLifecycle: d.agent.podLifecycle,
            })
          ).agent,
        (a) => (trigger ? api.createPersistentAgentTrigger(a.id, trigger) : Promise.resolve()),
        (a) => api.deletePersistentAgent(a.id),
      );
      return { kind, href: `/agents/${agent.id}`, toast: `${name} created` };
    }
  }
}

// ── Editing ──────────────────────────────────────────────────────────────────

interface TriggerOps {
  create: (t: { type: string; config: Record<string, unknown>; enabled: true }) => Promise<unknown>;
  update: (triggerId: string, data: { config: Record<string, unknown> }) => Promise<unknown>;
  remove: (triggerId: string) => Promise<unknown>;
}

/**
 * Bring the one trigger the form edits in line with the draft. Same type:
 * patch its config in place (a webhook keeps its path, a schedule its id).
 * Different type: create the new one first, then retire the old, so a
 * rejected config never leaves the row with no trigger. Triggers the form
 * didn't load (a second one added elsewhere) are left alone.
 */
async function syncTrigger(
  target: EditTarget,
  wanted: { type: string; config: Record<string, unknown> } | null,
  ops: TriggerOps,
): Promise<void> {
  const current = target.trigger;
  if (!wanted) {
    if (current) await ops.remove(current.id);
    return;
  }
  if (current && current.type === wanted.type) {
    await ops.update(current.id, { config: wanted.config });
    return;
  }
  await ops.create({ ...wanted, enabled: true });
  if (current) await ops.remove(current.id);
}

/**
 * Save an edited draft back onto its row. The kind is fixed (the form refuses
 * answers that would change it), so this is the PATCH half of `createOnce`'s
 * branch for that kind plus a trigger sync. Returns where to go next.
 */
export async function updateWork(
  target: EditTarget,
  d: WorkDraft,
  ctx: { repoUrl: string },
): Promise<Created> {
  const { id, kind } = target;
  const name = d.name.trim() || target.row.name || target.row.title;
  const runName = runNameFor(d);
  const prompt = d.prompt.trim();
  const trigger = triggerFor(d);
  const location = runLocationPayload(d.location);
  const options = setOptions(d);
  const model = pickedModel(d);
  const { repoUrl } = ctx;
  const wanted = trigger ? { type: trigger.type, config: trigger.config } : null;
  const href = detailHref(target);

  switch (kind) {
    case "repo-blueprint": {
      await api.updateTaskConfig(id, {
        name,
        title: runName ?? name,
        prompt,
        description: d.description || null,
        agentType: d.runtime,
        agentOptions: options,
        maxRetries: d.maxRetries,
        priority: d.priority,
        repoUrl,
        repoBranch: d.repoBranch,
        ...location,
      });
      await syncTrigger(target, wanted, {
        create: (t) => api.createTaskTrigger(id, t as Parameters<typeof api.createTaskTrigger>[1]),
        update: (tid, data) => api.updateTaskTrigger(id, tid, data),
        remove: (tid) => api.deleteTaskTrigger(id, tid),
      });
      return { kind, href, toast: `${name} saved` };
    }

    case "standalone": {
      await api.updateWorkflow(id, {
        name,
        runTitle: runName,
        promptTemplate: prompt,
        // The Job PATCH takes a string here (blank clears it), not null.
        description: d.description,
        agentRuntime: d.runtime,
        model: model ?? null,
        agentOptions: options,
        maxRetries: d.maxRetries,
        ...location,
      });
      await syncTrigger(target, wanted, {
        create: (t) => api.createTaskTrigger(id, t as Parameters<typeof api.createTaskTrigger>[1]),
        update: (tid, data) => api.updateTaskTrigger(id, tid, data),
        remove: (tid) => api.deleteTaskTrigger(id, tid),
      });
      return { kind, href, toast: `${name} saved` };
    }

    case "local-blueprint": {
      await api.updateLocalBlueprint(id, {
        name,
        description: d.description || null,
        hostId: d.location.localHostId || null,
        dir: d.location.localDir || null,
        repoUrl: d.withRepo && repoUrl ? repoUrl : null,
        baseBranch: d.withRepo ? d.repoBranch || "main" : null,
        commandTemplate: prompt,
        runTitle: runName,
        agent: d.runtime === TERMINAL ? null : (d.runtime as "claude-code"),
        sessionMode: d.then === "waits-for-me" ? "interactive" : "headless",
      });
      await syncTrigger(target, wanted, {
        create: (t) =>
          api.createLocalBlueprintTrigger(
            id,
            t as Parameters<typeof api.createLocalBlueprintTrigger>[1],
          ),
        update: (tid, data) => api.updateLocalBlueprintTrigger(id, tid, data),
        remove: (tid) => api.deleteLocalBlueprintTrigger(id, tid),
      });
      return { kind, href, toast: `${name} saved` };
    }
  }
}
