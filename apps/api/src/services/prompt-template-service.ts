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
}> {
  // Check repo-level override first
  if (repoUrl) {
    const normalized = normalizeRepoUrl(repoUrl);
    const [repo] = await db.select().from(repos).where(eq(repos.repoUrl, normalized));
    if (repo?.promptTemplateOverride) {
      return {
        id: repo.id,
        template: repo.promptTemplateOverride,
        autoMerge: repo.autoMerge,
      };
    }
    // Also use the repo's autoMerge setting even if no prompt override
    if (repo) {
      const globalTemplate = await getGlobalDefault();
      return {
        ...globalTemplate,
        autoMerge: repo.autoMerge,
      };
    }
  }

  return getGlobalDefault();
}

async function getGlobalDefault(): Promise<{
  id: string;
  template: string;
  autoMerge: boolean;
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
    };
  }

  return {
    id: "builtin",
    template: DEFAULT_PROMPT_TEMPLATE,
    autoMerge: false,
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
 * List all prompt templates, optionally scoped to a workspace.
 */
export async function listPromptTemplates(workspaceId?: string | null) {
  if (workspaceId) {
    return db
      .select()
      .from(promptTemplates)
      .where(or(eq(promptTemplates.workspaceId, workspaceId), isNull(promptTemplates.workspaceId)));
  }
  return db.select().from(promptTemplates);
}
