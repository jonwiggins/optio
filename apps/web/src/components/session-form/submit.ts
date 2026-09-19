import { api } from "@/lib/api-client";
import { runLocationPayload } from "@/components/run-location-picker";
import { defaultAgentsMd } from "@/lib/persistent-agent-defaults";
import { deriveKind, isEventWhen, isLocal, SHELL, type SessionDraft } from "./model";

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

/**
 * Turn a draft into the row(s) its kind needs. Each branch calls the same
 * service the dedicated form for that kind calls today, so nothing about how
 * a Task, Job, automation, terminal, or agent runs changes — only where you
 * make it.
 */
export async function createSession(d: SessionDraft, repoUrl: string): Promise<Created> {
  const kind = deriveKind(d);
  const title = d.title.trim();
  const prompt = d.prompt.trim();
  const trigger = genericTrigger(d);
  const location = runLocationPayload(d.location);

  switch (kind) {
    case "repo-task": {
      const { task } = await api.createTaskUnified({
        type: "repo-task",
        title,
        prompt,
        description: d.description || undefined,
        agentType: d.runtime,
        maxRetries: d.maxRetries,
        priority: d.priority,
        repoUrl,
        repoBranch: d.repoBranch,
        ...(d.dependsOn.length ? { dependsOn: d.dependsOn } : {}),
        ...location,
      });
      return { kind, href: `/tasks/${task.id}`, toast: "Session started — it will open a PR" };
    }

    case "repo-blueprint": {
      const { task } = await api.createTaskUnified({
        type: "repo-blueprint",
        title,
        name: title,
        prompt,
        description: d.description || undefined,
        agentType: d.runtime,
        maxRetries: d.maxRetries,
        priority: d.priority,
        repoUrl,
        repoBranch: d.repoBranch,
        enabled: true,
        ...location,
      });
      if (trigger) await api.createTaskTrigger(task.id, trigger);
      return { kind, href: `/tasks/scheduled/${task.id}`, toast: "Session saved" };
    }

    case "standalone": {
      const { task } = await api.createTaskUnified({
        type: "standalone",
        title,
        name: title,
        prompt,
        description: d.description || undefined,
        agentType: d.runtime,
        maxRetries: d.maxRetries,
        enabled: true,
        ...location,
      });
      if (trigger) {
        await api.createTaskTrigger(task.id, trigger);
        return { kind, href: `/jobs/${task.id}`, toast: "Session saved" };
      }
      const run = await api.createTaskRun(task.id);
      return { kind, href: `/jobs/${task.id}/runs/${run.runId}`, toast: "Session started" };
    }

    case "local-blueprint": {
      const { blueprint } = await api.createLocalBlueprint({
        name: title,
        description: d.description || undefined,
        hostId: d.location.localHostId,
        dir: d.location.localDir,
        ...(repoUrl ? { repoUrl } : {}),
        commandTemplate: prompt,
        agent: d.runtime === SHELL ? null : (d.runtime as "claude-code"),
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
      return { kind, href: "/local", toast: "Automation saved" };
    }

    case "local-terminal": {
      const { terminal } = await api.createLocalTerminal({
        hostId: d.location.localHostId,
        dir: d.location.localDir,
        ...(title ? { title } : {}),
        spec:
          d.runtime === SHELL
            ? { kind: "shell" }
            : { kind: "agent", agent: d.runtime, ...(prompt ? { prompt } : {}) },
      });
      return { kind, href: `/local/${terminal.id}`, toast: "Session opened" };
    }

    case "pod-session": {
      const { session } = await api.createSession({ repoUrl });
      return { kind, href: `/sessions/${session.id}`, toast: "Session opened" };
    }

    case "persistent-agent": {
      const { agent } = await api.createPersistentAgent({
        slug: d.agent.slug.trim(),
        name: d.agent.name.trim() || title,
        description: d.description || undefined,
        agentRuntime: d.runtime,
        model: d.agent.model || null,
        systemPrompt: d.agent.systemPrompt || null,
        agentsMd: d.agent.agentsMd || defaultAgentsMd(),
        initialPrompt: prompt,
        podLifecycle: d.agent.podLifecycle,
      });
      if (trigger) {
        await api.createPersistentAgentTrigger(agent.id, trigger);
      }
      return { kind, href: `/agents/${agent.id}`, toast: "Agent created" };
    }
  }
}

export { isLocal };
