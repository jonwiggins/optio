/** `kind: Prompt` — a named prompt template (`prompt_templates`). */
import { MANIFEST_API_VERSION, type PromptManifest } from "@optio/shared";
import { promptTemplates } from "../../../db/schema.js";
import {
  createNamedTemplate,
  deleteNamedTemplate,
  getPromptTemplateById,
  listPromptTemplates,
  updateNamedTemplate,
} from "../../prompt-template-service.js";
import { ManifestError, type ResolveContext, type ResourceTable } from "../context.js";
import { compact, fieldChanges } from "../compare.js";
import type { Identified, KindHandler } from "./index.js";

type Row = typeof promptTemplates.$inferSelect;

interface DesiredPrompt {
  name: string;
  template: string;
  kind: string;
  description: string | null;
  paramsSchema: Record<string, unknown> | null;
  defaultAgentType: string | null;
}

const NAMED_KINDS = new Set(["prompt", "review", "job", "task"]);

async function desire(m: PromptManifest): Promise<DesiredPrompt> {
  if (m.spec.template === undefined) {
    throw new ManifestError("templateFile must be read into template before an apply");
  }
  return {
    name: m.metadata.name,
    template: m.spec.template,
    kind: m.spec.kind ?? "prompt",
    description: m.metadata.description ?? null,
    paramsSchema: m.spec.params ?? null,
    defaultAgentType: m.spec.defaultAgentType ?? null,
  };
}

/** The workspace's own named prompts (not the instance-wide system rows). */
async function workspaceRows(ctx: ResolveContext): Promise<Row[]> {
  const rows = await listPromptTemplates({ workspaceId: ctx.workspaceId ?? undefined });
  return rows.filter(
    (r) => (r.workspaceId ?? null) === ctx.workspaceId && !r.isDefault && NAMED_KINDS.has(r.kind),
  );
}

async function find(d: DesiredPrompt, ctx: ResolveContext): Promise<Row | null> {
  const rows = await workspaceRows(ctx);
  const row = rows.find((r) => r.name === d.name && !r.ownerUserId) ?? null;
  if (!row && rows.some((r) => r.name === d.name)) {
    throw new ManifestError(
      `A prompt named "${d.name}" exists, but it is someone's private prompt`,
    );
  }
  return row;
}

async function get(_table: ResourceTable, id: string): Promise<Row | null> {
  return (await getPromptTemplateById(id)) ?? null;
}

function identify(row: Row): Identified {
  return { table: "prompt_templates", id: row.id, name: row.name, ownerUserId: row.ownerUserId };
}

function desiredColumns(d: DesiredPrompt) {
  return {
    name: d.name,
    template: d.template,
    kind: d.kind,
    description: d.description,
    paramsSchema: d.paramsSchema,
    defaultAgentType: d.defaultAgentType,
  };
}

async function diff(row: Row, d: DesiredPrompt): Promise<string[]> {
  const changes = fieldChanges(row as unknown as Record<string, unknown>, desiredColumns(d));
  if (row.ownerUserId) changes.push("owner");
  return changes;
}

async function create(d: DesiredPrompt, ctx: ResolveContext): Promise<Row> {
  return createNamedTemplate({
    ...desiredColumns(d),
    workspaceId: ctx.workspaceId,
    ownerUserId: null,
  });
}

async function update(row: Row, d: DesiredPrompt): Promise<Row> {
  return (await updateNamedTemplate(row.id, desiredColumns(d))) ?? row;
}

async function remove(_table: ResourceTable, id: string): Promise<void> {
  await deleteNamedTemplate(id);
}

async function list(ctx: ResolveContext): Promise<Row[]> {
  return (await workspaceRows(ctx))
    .filter((r) => !r.ownerUserId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function exportPrompt(row: Row): Promise<PromptManifest> {
  return {
    apiVersion: MANIFEST_API_VERSION,
    kind: "Prompt",
    metadata: compact({
      name: row.name,
      description: row.description ?? undefined,
    }) as PromptManifest["metadata"],
    spec: compact({
      kind: row.kind === "prompt" ? undefined : (row.kind as PromptManifest["spec"]["kind"]),
      template: row.template,
      params: (row.paramsSchema as Record<string, unknown> | null) ?? undefined,
      defaultAgentType: row.defaultAgentType ?? undefined,
    }) as PromptManifest["spec"],
  };
}

export const promptHandler: KindHandler<PromptManifest, DesiredPrompt, Row> = {
  kind: "Prompt",
  desire,
  tableOf: () => "prompt_templates",
  find,
  get,
  identify,
  replaceReason: () => null,
  diff,
  create,
  update,
  remove,
  list,
  export: exportPrompt,
};
