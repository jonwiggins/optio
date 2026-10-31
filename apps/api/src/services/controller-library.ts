/** Library operations use references and prompt text; credentials stay in Settings. */
import { and, eq, ilike } from "drizzle-orm";
import type { ControllerPrincipal } from "./controller-auth.js";
import { ControllerError, requireManage, tenant } from "./controller-access.js";
import { db } from "../db/client.js";
import { promptTemplates, repos } from "../db/schema.js";
import { canSee, canUse, visibleOwner } from "./ownership.js";
import * as prompts from "./prompt-template-service.js";

export async function listControllerPrompts(
  p: ControllerPrincipal,
  input: { kind?: string; search?: string; limit: number; offset: number },
) {
  const rows = await db
    .select()
    .from(promptTemplates)
    .where(
      and(
        tenant(promptTemplates.workspaceId, p.actor.workspaceId),
        visibleOwner(promptTemplates.ownerUserId, p.actor),
        input.kind ? eq(promptTemplates.kind, input.kind) : undefined,
        input.search ? ilike(promptTemplates.name, `%${input.search}%`) : undefined,
      ),
    )
    .orderBy(promptTemplates.name, promptTemplates.id)
    .limit(input.limit + 1)
    .offset(input.offset);
  return {
    prompts: rows.slice(0, input.limit).map(({ template: _text, ...row }) => row),
    nextOffset: rows.length > input.limit ? input.offset + input.limit : null,
  };
}
/**
 * Prompts follow the scope rule alone (no team owner, no work visibility):
 * a team's work reaches the organization's prompts, a person's their own too.
 */
export async function getControllerPrompt(p: ControllerPrincipal, id: string) {
  const row = await prompts.getPromptTemplateById(id);
  if (!row || row.workspaceId !== p.actor.workspaceId || !canSee(row.ownerUserId, p.actor))
    throw new ControllerError(404, "Work not found");
  return row;
}
function requirePromptChange(p: ControllerPrincipal, row: { ownerUserId: string | null }) {
  requireManage(p);
  const owner = p.actor.executionTeamId ? null : p.actor.userId;
  if (!canUse(row.ownerUserId, owner))
    throw new ControllerError(403, "Only its owner can change a private prompt");
}
export async function previewControllerPrompt(
  p: ControllerPrincipal,
  id: string,
  params: Record<string, unknown>,
) {
  const row = await getControllerPrompt(p, id);
  return { rendered: prompts.renderTemplateString(row.template, params) };
}
export async function createControllerPrompt(
  p: ControllerPrincipal,
  input: Omit<Parameters<typeof prompts.createNamedTemplate>[0], "workspaceId" | "ownerUserId">,
) {
  requireManage(p);
  // A team's work must not write into its creator's own prompts.
  if (p.actor.executionTeamId) throw new ControllerError(403, "A team's work can't create prompts");
  return {
    template: await prompts.createNamedTemplate({
      ...input,
      workspaceId: p.actor.workspaceId,
      ownerUserId: p.actor.userId,
    }),
  };
}
export async function updateControllerPrompt(
  p: ControllerPrincipal,
  id: string,
  input: Parameters<typeof prompts.updateNamedTemplate>[1],
) {
  requirePromptChange(p, await getControllerPrompt(p, id));
  return { template: await prompts.updateNamedTemplate(id, input) };
}
export async function deleteControllerPrompt(p: ControllerPrincipal, id: string) {
  requirePromptChange(p, await getControllerPrompt(p, id));
  return { id, deleted: await prompts.deleteNamedTemplate(id) };
}
export async function controllerEnvironment(
  p: ControllerPrincipal,
  repoId: string | undefined,
  agentType: string,
) {
  let repoUrl: string | null = null;
  if (repoId) {
    const [repo] = await db
      .select()
      .from(repos)
      .where(and(eq(repos.id, repoId), tenant(repos.workspaceId, p.actor.workspaceId)));
    if (!repo) throw new ControllerError(404, "Repository not found");
    repoUrl = repo.repoUrl;
  }
  const { environmentOptions } = await import("./agent-environment-service.js");
  const options = await environmentOptions(
    {
      repoUrl,
      agentType,
      workspaceId: p.actor.workspaceId,
      ownerUserId: p.actor.userId,
      ownerTeamId: p.actor.executionTeamId ?? null,
    },
    p.actor,
  );
  // MCP command args and setup scripts can contain hand-written credentials.
  // Selection needs ids and availability, never raw launch configuration.
  const references = (rows: typeof options.skills) =>
    rows.map(({ id, name, scope, default: on, private: personal }) => ({
      id,
      name,
      scope,
      default: on,
      private: personal ?? false,
    }));
  return {
    connections: references(options.connections),
    mcpServers: references(options.mcpServers),
    skills: references(options.skills),
    repo: options.repo
      ? {
          reviewEnabled: options.repo.reviewEnabled,
          reviewTrigger: options.repo.reviewTrigger,
          cautiousMode: options.repo.cautiousMode,
          maxAutoResumes: options.repo.maxAutoResumes,
        }
      : null,
  };
}

/** The same model/option catalog the work form reads; cache refresh remains in Settings. */
export async function controllerModels(
  p: ControllerPrincipal,
  provider: import("@optio/shared").AgentProviderId,
) {
  const { getProviderOptions } = await import("./agent-options-service.js");
  const result = await getProviderOptions(provider, {
    workspaceId: p.actor.workspaceId,
    ...(p.run?.sessionId ? { machines: { userId: p.actor.userId } } : {}),
  });
  return {
    provider,
    catalog: result.catalog,
    source: result.source,
    cached: result.cached,
    refreshedAt: result.refreshedAt,
  };
}
