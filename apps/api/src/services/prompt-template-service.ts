import { eq, and, isNull, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { promptTemplates } from "../db/schema.js";
import {
  DEFAULT_REVIEW_PROMPT_TEMPLATE,
  builtinPromptTemplates,
  normalizeRepoUrl,
  resolveRepoPlatform,
  shellQuote,
} from "@optio/shared";
import { canUse, visibleOwner, type Actor } from "./ownership.js";
import { getRepoByUrl } from "./repo-service.js";
import { isAuthDisabled } from "./oauth/index.js";

/**
 * Default prompts, by scope. The coding default (`is_default`, no repo) and
 * the review default (named `review-default`) are each a workspace's own
 * row, falling back to the deployment's (no workspace), then to the built-in
 * prompt. A workspace admin writes the workspace's; only a deployment admin
 * writes the deployment's, which every workspace reads (routes/prompt-templates.ts).
 * `workspaceId` null is the deployment's scope — and, with auth disabled, the
 * single local workspace's.
 */
export const REVIEW_DEFAULT_NAME = "review-default";

/** The rows of one scope: the workspace's own, or the deployment's (no workspace). */
const inScope = (workspaceId: string | null) =>
  workspaceId ? eq(promptTemplates.workspaceId, workspaceId) : isNull(promptTemplates.workspaceId);

/** The workspace's row and the deployment's, for a read that prefers the first. */
const scopeAndDeployment = (workspaceId: string | null) =>
  workspaceId
    ? or(eq(promptTemplates.workspaceId, workspaceId), isNull(promptTemplates.workspaceId))!
    : isNull(promptTemplates.workspaceId);

/** The workspace's row of `rows` when there is one, else the deployment's. */
function preferWorkspace<T extends { workspaceId: string | null }>(
  rows: T[],
  workspaceId: string | null,
): T | undefined {
  return (
    (workspaceId ? rows.find((r) => r.workspaceId === workspaceId) : undefined) ??
    rows.find((r) => r.workspaceId === null)
  );
}

/**
 * A default / repo row rather than one of the Prompts library's named
 * prompts: the coding default, a repo's prompt, or the review default (the
 * organization's row named `review-default`, which is why a named prompt
 * can't take that name).
 */
export function isSystemPromptRow(row: {
  isDefault: boolean;
  repoUrl: string | null;
  name: string;
  ownerUserId: string | null;
}): boolean {
  return row.isDefault || !!row.repoUrl || (row.name === REVIEW_DEFAULT_NAME && !row.ownerUserId);
}

/** Why a named prompt can't be called `name` (it is the review default's); null when it can. */
export function reservedPromptName(name: string | undefined): string | null {
  return name === REVIEW_DEFAULT_NAME
    ? `"${REVIEW_DEFAULT_NAME}" is the review default's name — save the review prompt in Settings, or pick another name`
    : null;
}

/** The repo settings the effective prompt reads (a `repos` row, or repo-service's RepoRecord). */
export interface PromptRepoSettings {
  id: string;
  promptTemplateOverride: string | null;
  autoMerge: boolean;
  cautiousMode: boolean;
  gitPlatform?: string | null;
}

/**
 * Get the prompt template for a repo in a workspace. Priority:
 * 1. The repo's override (repos.promptTemplateOverride) — the workspace's own repo row
 * 2. The workspace's default (prompt_templates)
 * 3. The deployment's default
 * 4. The built-in prompt for the repo's platform
 *
 * `scope.repo` is the repo row the caller already loaded for this workspace
 * (null: the repo isn't added); left out, it is looked up in
 * `scope.workspaceId` — never another workspace's row for the same URL.
 */
export async function getPromptTemplate(
  repoUrl: string | undefined,
  scope: { workspaceId: string | null; repo?: PromptRepoSettings | null },
): Promise<{
  id: string;
  template: string;
  autoMerge: boolean;
  cautiousMode: boolean;
}> {
  const { workspaceId } = scope;
  if (repoUrl) {
    const repo =
      scope.repo !== undefined
        ? scope.repo
        : await getRepoByUrl(normalizeRepoUrl(repoUrl), workspaceId);
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
      const globalTemplate = await getGlobalDefault(
        resolveRepoPlatform(repoUrl, repo.gitPlatform ?? null),
        workspaceId,
      );
      return {
        ...globalTemplate,
        autoMerge: repo.cautiousMode ? false : repo.autoMerge,
        cautiousMode: repo.cautiousMode,
      };
    }
  }

  return getGlobalDefault(repoUrl ? resolveRepoPlatform(repoUrl) : null, workspaceId);
}

/** The workspace's saved default, else the deployment's, else the built-in prompt for the repo's platform. */
async function getGlobalDefault(
  platform: string | null,
  workspaceId: string | null,
): Promise<{
  id: string;
  template: string;
  autoMerge: boolean;
  cautiousMode: boolean;
}> {
  const rows = await db
    .select()
    .from(promptTemplates)
    .where(
      and(
        eq(promptTemplates.isDefault, true),
        isNull(promptTemplates.repoUrl),
        isNull(promptTemplates.ownerUserId),
        scopeAndDeployment(workspaceId),
      ),
    );
  const defaultTemplate = preferWorkspace(rows, workspaceId);

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
    template: builtinPromptTemplates(platform).task,
    autoMerge: false,
    cautiousMode: false,
  };
}

/** Where a default prompt comes from: a workspace's own, the deployment's, or the built-in one. */
export type DefaultPromptSource = "workspace" | "deployment" | "builtin";

/**
 * A default prompt (the coding default, or the review default) as a scope
 * reads it, and where it comes from: the workspace's own, else the
 * deployment's, else the built-in prompt. `workspaceId` null reads the
 * deployment's.
 */
export async function getDefaultPromptWithSource(
  kind: "coding" | "review",
  workspaceId: string | null,
): Promise<{ template: string; autoMerge: boolean; source: DefaultPromptSource }> {
  const rows = await db
    .select()
    .from(promptTemplates)
    .where(
      and(
        kind === "coding"
          ? eq(promptTemplates.isDefault, true)
          : eq(promptTemplates.name, REVIEW_DEFAULT_NAME),
        isNull(promptTemplates.repoUrl),
        isNull(promptTemplates.ownerUserId),
        scopeAndDeployment(workspaceId),
      ),
    );
  const row = preferWorkspace(rows, workspaceId);
  if (row) {
    return {
      template: row.template,
      autoMerge: kind === "coding" ? row.autoMerge : false,
      source: row.workspaceId ? "workspace" : "deployment",
    };
  }
  return {
    template:
      kind === "coding" ? builtinPromptTemplates(null).task : DEFAULT_REVIEW_PROMPT_TEMPLATE,
    autoMerge: false,
    source: "builtin",
  };
}

/**
 * Save or update the default coding prompt of a scope: a workspace's
 * (`workspaceId`), or the deployment's (null). Who may is the route's check.
 */
export async function saveDefaultPromptTemplate(
  template: string,
  autoMerge: boolean,
  workspaceId: string | null,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(promptTemplates)
    .where(
      and(
        eq(promptTemplates.isDefault, true),
        isNull(promptTemplates.repoUrl),
        isNull(promptTemplates.ownerUserId),
        inScope(workspaceId),
      ),
    );

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
      workspaceId,
    });
  }
}

/**
 * Save or update a repo-specific prompt template, in one workspace's scope
 * (a row per workspace and repo URL; null = the deployment's, auth disabled).
 */
export async function saveRepoPromptTemplate(
  rawRepoUrl: string,
  template: string,
  autoMerge: boolean,
  workspaceId: string | null,
): Promise<void> {
  const repoUrl = normalizeRepoUrl(rawRepoUrl);
  const [existing] = await db
    .select()
    .from(promptTemplates)
    .where(
      and(
        eq(promptTemplates.repoUrl, repoUrl),
        isNull(promptTemplates.ownerUserId),
        inScope(workspaceId),
      ),
    );

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
      workspaceId,
    });
  }
}

/** The review default's text: the workspace's, else the deployment's; null = the built-in one. */
export async function getReviewDefaultTemplate(workspaceId: string | null): Promise<string | null> {
  const rows = await db
    .select()
    .from(promptTemplates)
    .where(
      and(
        eq(promptTemplates.name, REVIEW_DEFAULT_NAME),
        isNull(promptTemplates.repoUrl),
        isNull(promptTemplates.ownerUserId),
        scopeAndDeployment(workspaceId),
      ),
    );
  return preferWorkspace(rows, workspaceId)?.template ?? null;
}

/** Save the review default of a scope: a workspace's, or the deployment's (null). */
export async function saveReviewDefaultTemplate(
  template: string,
  workspaceId: string | null,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(promptTemplates)
    .where(
      and(
        eq(promptTemplates.name, REVIEW_DEFAULT_NAME),
        isNull(promptTemplates.repoUrl),
        isNull(promptTemplates.ownerUserId),
        inScope(workspaceId),
      ),
    );
  if (existing) {
    await db
      .update(promptTemplates)
      .set({ template, updatedAt: new Date() })
      .where(eq(promptTemplates.id, existing.id));
  } else {
    await db.insert(promptTemplates).values({
      name: REVIEW_DEFAULT_NAME,
      template,
      isDefault: false,
      workspaceId,
    });
  }
}

/**
 * List all prompt templates, optionally scoped to a workspace and filtered by kind.
 */
export async function listPromptTemplates(opts?: {
  workspaceId?: string | null;
  kind?: string;
  /** Only the prompts this viewer may see: the organization's and their own (ownership.ts). */
  viewer?: Actor;
}) {
  const conditions = [];
  if (opts?.workspaceId) {
    conditions.push(
      or(
        eq(promptTemplates.workspaceId, opts.workspaceId),
        // The deployment's prompts (starters, the defaults) — not repo rows
        // saved without a workspace, which were some workspace's own.
        and(isNull(promptTemplates.workspaceId), isNull(promptTemplates.repoUrl)),
      )!,
    );
  }
  if (opts?.kind) conditions.push(eq(promptTemplates.kind, opts.kind));
  if (opts?.viewer) {
    const visible = visibleOwner(promptTemplates.ownerUserId, opts.viewer);
    if (visible) conditions.push(visible);
  }

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

/** The work a saved prompt is linked to: its workspace and its owner (null = the organization's). */
export interface PromptUser {
  workspaceId: string | null | undefined;
  ownerUserId: string | null | undefined;
}

/**
 * Whether work may use a saved prompt (`promptTemplateId` on a scheduled
 * Task, a persistent agent, a Local automation): one of its own workspace's
 * or the deployment's (no workspace), and the organization's or the work
 * owner's own (ownership.ts `canUse`). Work with no workspace is a local
 * install's with auth disabled, which has only the one.
 */
export function promptUsableBy(
  row: { workspaceId: string | null; ownerUserId: string | null; repoUrl?: string | null },
  work: PromptUser,
): boolean {
  const local = !work.workspaceId && isAuthDisabled();
  if (row.workspaceId && row.workspaceId !== (work.workspaceId ?? null) && !local) return false;
  // A repo row saved without a workspace was some workspace's own, not the deployment's.
  if (!row.workspaceId && row.repoUrl && !local) return false;
  return canUse(row.ownerUserId, work.ownerUserId);
}

/** Why work may not be saved with the prompt `id`; null when it may. */
export async function savedPromptRefusal(id: string, work: PromptUser): Promise<string | null> {
  const row = await getPromptTemplateById(id);
  if (!row) return "Saved prompt not found";
  if (promptUsableBy(row, work)) return null;
  // The workspace's, but private: say why, for organization work.
  if (row.ownerUserId && !work.ownerUserId && promptUsableBy({ ...row, ownerUserId: null }, work)) {
    return "Organization work can't use a private prompt — pick one of the organization's, or make the work yours";
  }
  return "Saved prompt not found";
}

/** The saved prompt work renders, refused when it is another workspace's or someone else's private one. */
export async function usableSavedPrompt(id: string, work: PromptUser) {
  const row = await getPromptTemplateById(id);
  if (!row) return null;
  if (!promptUsableBy(row, work)) {
    throw new Error(
      `Saved prompt ${id} isn't this work's to use (another workspace's, or someone's private prompt) — pick another`,
    );
  }
  return row;
}

/**
 * Resolve `{{#if param}}...{{/if}}` blocks only — keep the body if the param
 * is truthy, drop it otherwise — leaving `{{param}}` placeholders in place.
 * A block with `{{else}}` keeps the part after it when the param is falsy
 * (`{{#if GIT_PLATFORM_GITLAB}}glab …{{else}}gh …{{/if}}`); a block without
 * one renders as before.
 */
function resolveTemplateConditionals(template: string, params: Record<string, unknown>): string {
  return template.replace(
    /\{\{#if\s+(\w+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, key: string, body: string) => {
      const value = params[key];
      const at = body.indexOf("{{else}}");
      if (at === -1) return value ? body : "";
      return value ? body.slice(0, at) : body.slice(at + "{{else}}".length);
    },
  );
}

/**
 * The repo's platform as template params, for a prompt written for every
 * platform (the starter prompts' `{{#if GIT_PLATFORM_GITLAB}}` arms, the
 * same variable the built-in prompts use). Empty for a template that names
 * no `GIT_PLATFORM_*` variable, so other prompts render exactly as before;
 * a param the caller passes under the same name wins.
 */
export function platformTemplateParams(
  template: string,
  platform: string | null | undefined,
): Record<string, string> {
  if (!templateUsesPlatform(template)) return {};
  return { GIT_PLATFORM_GITLAB: platform === "gitlab" ? "true" : "" };
}

/** Whether a template names a `GIT_PLATFORM_*` variable (and so needs its repo's platform). */
export function templateUsesPlatform(template: string): boolean {
  return /\bGIT_PLATFORM_[A-Z]+\b/.test(template);
}

/**
 * Render a template string by substituting {{param}} placeholders with values
 * from the params bag. Unknown placeholders are left intact so callers can
 * detect missing params. Supports simple {{#if param}}...{{/if}} blocks too.
 */
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

/**
 * A shell command from a `{{param}}` template. Each value becomes a shell
 * variable, assigned single-quoted on the first line (`OPTIO_PARAM_title='…'`),
 * and each `{{title}}` turns into a reference to it in the form its quoting
 * needs — `"${OPTIO_PARAM_title}"` bare, `${OPTIO_PARAM_title}` inside double
 * quotes, `'"${OPTIO_PARAM_title}"'` inside single quotes — so the shell
 * running the command never parses a value as code, not even in
 * `"New issue: {{title}}"`. `{{#if}}` blocks are decided on the raw values.
 *
 * That protects the one shell only. A template that hands the value to a
 * second parser — `sh -c "…{{x}}…"`, `ssh host "…"`, `eval`, `python -c`, or
 * bash arithmetic (`(( ))`, `$(( ))`, `[[ {{n}} -eq 1 ]]`, `let`, array
 * subscripts) — has it parsed as code there. Saves refuse those templates
 * (`commandTemplateRefusal` in command-template-check.ts).
 */
export function renderCommandTemplate(
  template: string,
  params: Record<string, unknown> | null | undefined,
): string {
  const raw = params ?? {};
  const body = resolveTemplateConditionals(template, raw).trim();
  const used = new Set<string>();
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < body.length; i++) {
    const placeholder = /^\{\{\s*(\w+)\s*\}\}/.exec(body.slice(i, i + 200));
    if (placeholder && Object.prototype.hasOwnProperty.call(raw, placeholder[1])) {
      const ref = `\${OPTIO_PARAM_${placeholder[1]}}`;
      out += quote === '"' ? ref : quote === "'" ? `'"${ref}"'` : `"${ref}"`;
      used.add(placeholder[1]);
      i += placeholder[0].length - 1;
      continue;
    }
    const c = body[i];
    out += c;
    if (c === "\\" && quote !== "'") {
      // An escaped character is never a quote.
      if (i + 1 < body.length) out += body[++i];
    } else if (quote === null && (c === "'" || c === '"')) {
      quote = c;
    } else if (c === quote) {
      quote = null;
    }
  }
  const assignments = [...used].map(
    (key) => `OPTIO_PARAM_${key}=${shellQuote(String(raw[key] ?? ""))}`,
  );
  return [...assignments, out].join("\n");
}

const RUN_TITLE_MAX = 200;

/**
 * The name a run gets from its definition's run-title template and the
 * trigger's params ("Triage: {{ticketTitle}}" → "Triage: Login is broken").
 * Unlike a prompt, a title is shown, not parsed: a placeholder the firing
 * didn't carry (a manual run of a Linear-triggered definition) renders
 * empty, whitespace collapses to one line, and a blank result — or no
 * template — falls back to `fallback`.
 */
export function renderRunTitle(
  template: string | null | undefined,
  params: Record<string, unknown> | null | undefined,
  fallback: string,
): string {
  if (!template?.trim()) return fallback;
  const bag = params ?? {};
  const title = renderTemplateString(template, bag)
    .replace(/\{\{\s*\w+\s*\}\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return fallback;
  return title.length > RUN_TITLE_MAX ? `${title.slice(0, RUN_TITLE_MAX - 1)}…` : title;
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
  /** Null = the organization's; set = one person's private prompt. */
  ownerUserId?: string | null;
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
      ownerUserId: input.ownerUserId ?? null,
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
