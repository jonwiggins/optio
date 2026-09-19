import { eq, and, isNull, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { promptTemplates, repos } from "../db/schema.js";
import { DEFAULT_PROMPT_TEMPLATE, normalizeRepoUrl } from "@optio/shared";

/**
 * Get the prompt template for a repo. Priority:
 * 1. Repo-level override (repos.promptTemplateOverride)
 * 2. Global default (prompt_templates table)
 * 3. Hardcoded default
 */
export async function getPromptTemplate(repoUrl?: string): Promise<{
  id: string;
  template: string;
  autoMerge: boolean;
  cautiousMode: boolean;
}> {
  // Check repo-level override first
  if (repoUrl) {
    const normalized = normalizeRepoUrl(repoUrl);
    const [repo] = await db.select().from(repos).where(eq(repos.repoUrl, normalized));
    if (repo?.promptTemplateOverride) {
      return {
        id: repo.id,
        template: repo.promptTemplateOverride,
        autoMerge: repo.cautiousMode ? false : repo.autoMerge,
        cautiousMode: repo.cautiousMode,
      };
    }
    // Also use the repo's autoMerge setting even if no prompt override
    if (repo) {
      const globalTemplate = await getGlobalDefault();
      return {
        ...globalTemplate,
        autoMerge: repo.cautiousMode ? false : repo.autoMerge,
        cautiousMode: repo.cautiousMode,
      };
    }
  }

  return getGlobalDefault();
}

async function getGlobalDefault(): Promise<{
  id: string;
  template: string;
  autoMerge: boolean;
  cautiousMode: boolean;
}> {
  const [defaultTemplate] = await db
    .select()
    .from(promptTemplates)
    .where(and(eq(promptTemplates.isDefault, true), isNull(promptTemplates.repoUrl)));

  if (defaultTemplate) {
    return {
      id: defaultTemplate.id,
      template: defaultTemplate.template,
      autoMerge: defaultTemplate.autoMerge,
      cautiousMode: false,
    };
  }

  return {
    id: "builtin",
    template: DEFAULT_PROMPT_TEMPLATE,
    autoMerge: false,
    cautiousMode: false,
  };
}

/**
 * Save or update the global default prompt template.
 */
export async function saveDefaultPromptTemplate(
  template: string,
  autoMerge: boolean,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(promptTemplates)
    .where(and(eq(promptTemplates.isDefault, true), isNull(promptTemplates.repoUrl)));

  if (existing) {
    await db
      .update(promptTemplates)
      .set({ template, autoMerge, updatedAt: new Date() })
      .where(eq(promptTemplates.id, existing.id));
  } else {
    await db.insert(promptTemplates).values({
      name: "default",
      template,
      isDefault: true,
      autoMerge,
    });
  }
}

/**
 * Save or update a repo-specific prompt template.
 */
export async function saveRepoPromptTemplate(
  rawRepoUrl: string,
  template: string,
  autoMerge: boolean,
): Promise<void> {
  const repoUrl = normalizeRepoUrl(rawRepoUrl);
  const [existing] = await db
    .select()
    .from(promptTemplates)
    .where(eq(promptTemplates.repoUrl, repoUrl));

  if (existing) {
    await db
      .update(promptTemplates)
      .set({ template, autoMerge, updatedAt: new Date() })
      .where(eq(promptTemplates.id, existing.id));
  } else {
    await db.insert(promptTemplates).values({
      name: `repo:${repoUrl}`,
      template,
      repoUrl,
      autoMerge,
    });
  }
}

/**
 * List all prompt templates, optionally scoped to a workspace and filtered by kind.
 */
export async function listPromptTemplates(opts?: { workspaceId?: string | null; kind?: string }) {
  const conditions = [];
  if (opts?.workspaceId) {
    conditions.push(
      or(eq(promptTemplates.workspaceId, opts.workspaceId), isNull(promptTemplates.workspaceId))!,
    );
  }
  if (opts?.kind) conditions.push(eq(promptTemplates.kind, opts.kind));

  if (conditions.length > 0) {
    return db
      .select()
      .from(promptTemplates)
      .where(and(...conditions));
  }
  return db.select().from(promptTemplates);
}

export async function getPromptTemplateById(id: string) {
  const [row] = await db.select().from(promptTemplates).where(eq(promptTemplates.id, id));
  return row ?? null;
}

/**
 * Render a template string by substituting {{param}} placeholders with values
 * from the params bag. Unknown placeholders are left intact so callers can
 * detect missing params. Supports simple {{#if param}}...{{/if}} blocks too.
 */
/**
 * Resolve `{{#if param}}...{{/if}}` blocks only — keep the body if the param
 * is truthy, drop it otherwise — leaving `{{param}}` placeholders in place.
 * Exposed so callers that transform param values before substitution (e.g.
 * shell-quoting, which turns "" into the truthy `''`) can test the raw ones.
 */
export function resolveTemplateConditionals(
  template: string,
  params: Record<string, unknown>,
): string {
  return template.replace(
    /\{\{#if\s+(\w+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, key: string, body: string) => {
      const value = params[key];
      return value ? body : "";
    },
  );
}

export function renderTemplateString(template: string, params: Record<string, unknown>): string {
  let rendered = resolveTemplateConditionals(template, params);

  // Simple {{param}} substitution.
  rendered = rendered.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const value = params[key];
      return value == null ? "" : String(value);
    }
    return match;
  });

  return rendered;
}

export async function renderTemplateById(
  id: string,
  params: Record<string, unknown>,
): Promise<string> {
  const template = await getPromptTemplateById(id);
  if (!template) throw new Error(`Template ${id} not found`);
  return renderTemplateString(template.template, params);
}

export async function createNamedTemplate(input: {
  name: string;
  template: string;
  kind?: string;
  description?: string | null;
  paramsSchema?: Record<string, unknown> | null;
  defaultAgentType?: string | null;
  workspaceId?: string | null;
}) {
  const [row] = await db
    .insert(promptTemplates)
    .values({
      name: input.name,
      template: input.template,
      kind: input.kind ?? "prompt",
      description: input.description ?? null,
      paramsSchema: input.paramsSchema ?? null,
      defaultAgentType: input.defaultAgentType ?? null,
      workspaceId: input.workspaceId ?? null,
      isDefault: false,
    })
    .returning();
  return row;
}

export async function updateNamedTemplate(
  id: string,
  input: Partial<{
    name: string;
    template: string;
    kind: string;
    description: string | null;
    paramsSchema: Record<string, unknown> | null;
    defaultAgentType: string | null;
  }>,
) {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) updates[k] = v;
  }
  const [row] = await db
    .update(promptTemplates)
    .set(updates)
    .where(eq(promptTemplates.id, id))
    .returning();
  return row ?? null;
}

export async function deleteNamedTemplate(id: string): Promise<boolean> {
  const deleted = await db.delete(promptTemplates).where(eq(promptTemplates.id, id)).returning();
  return deleted.length > 0;
}
