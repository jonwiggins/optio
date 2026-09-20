import { getProviderCatalog, providerForAgentType } from "@optio/shared";
import { api } from "@/lib/api-client";
import { runLocationPayload } from "@/components/run-location-picker";
import { defaultAgentsMd } from "@/lib/persistent-agent-defaults";
import { deriveKind, isEventWhen, slugify, TERMINAL, type SessionDraft } from "./model";

/** Where the browser goes once the session exists. */
export interface Created {
  kind: ReturnType<typeof deriveKind>;
  href: string;
  toast: string;
}

/** The generic trigger row (schedule / webhook / ticket) a draft asks for, if any. */
function genericTrigger(d: SessionDraft) {
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

/** Only the options the user actually set (blank selects mean "default"). */
function setOptions(d: SessionDraft): Record<string, string | boolean> | null {
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(d.agentOptions)) {
    if (v === "" || v === undefined) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** The model the draft picked for its runtime, for rows that carry just a model. */
export function pickedModel(d: SessionDraft): string | undefined {
  if (d.runtime === TERMINAL) return undefined;
  const catalog = getProviderCatalog(providerForAgentType(d.runtime));
  const v = catalog ? d.agentOptions[catalog.modelField] : undefined;
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Turn a draft into the row(s) its kind needs. Each branch calls the same
 * service the dedicated form for that kind calls today, so nothing about how
 * a Task, Job, automation, terminal, or agent runs changes — only where you
 * make it.
 */
export async function createSession(
  d: SessionDraft,
  ctx: { repoUrl: string; autoName: string },
): Promise<Created> {
  const kind = deriveKind(d);
  const name = d.name.trim() || ctx.autoName;
  const prompt = d.prompt.trim();
  const trigger = genericTrigger(d);
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
      const { task } = await api.createTaskUnified({
        type: "repo-blueprint",
        title: name,
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
      });
      if (trigger) await api.createTaskTrigger(task.id, trigger);
      return { kind, href: `/tasks/scheduled/${task.id}`, toast: `${name} saved` };
    }

    case "standalone": {
      const { task } = await api.createTaskUnified({
        type: "standalone",
        title: name,
        name,
        prompt,
        description: d.description || undefined,
        agentType: d.runtime,
        ...(model ? { model } : {}),
        agentOptions: options,
        maxRetries: d.maxRetries,
        enabled: true,
        ...location,
      });
      if (trigger) {
        await api.createTaskTrigger(task.id, trigger);
        return { kind, href: `/jobs/${task.id}`, toast: `${name} saved` };
      }
      const run = await api.createTaskRun(task.id);
      return { kind, href: `/jobs/${task.id}/runs/${run.runId}`, toast: `${name} started` };
    }

    case "local-blueprint": {
      const { blueprint } = await api.createLocalBlueprint({
        name,
        description: d.description || undefined,
        hostId: d.location.localHostId,
        dir: d.location.localDir,
        ...(d.withRepo && repoUrl ? { repoUrl } : {}),
        commandTemplate: prompt,
        agent: d.runtime === TERMINAL ? null : (d.runtime as "claude-code"),
        spawnMode: "auto",
        sessionMode: d.then === "waits-for-me" ? "interactive" : "headless",
      });
      if (isEventWhen(d.when)) {
        await api.createLocalBlueprintTrigger(blueprint.id, {
          type: d.when,
          config: d.event.config,
          enabled: true,
        });
      } else if (trigger) {
        await api.createLocalBlueprintTrigger(blueprint.id, trigger);
      }
      return { kind, href: "/local", toast: `${name} saved` };
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
              },
      });
      return { kind, href: `/local/${terminal.id}`, toast: `${name} opened` };
    }

    case "pod-session": {
      const { session } = await api.createSession({ repoUrl });
      return { kind, href: `/sessions/${session.id}`, toast: `${name} opened` };
    }

    case "persistent-agent": {
      const { agent } = await api.createPersistentAgent({
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
      });
      if (trigger) await api.createPersistentAgentTrigger(agent.id, trigger);
      return { kind, href: `/agents/${agent.id}`, toast: `${name} created` };
    }
  }
}
