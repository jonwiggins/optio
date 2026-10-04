/**
 * The apply: make a workspace's resources match a set of manifests. Per
 * manifest — validate, resolve, find the row it names, and create / update /
 * leave it / recreate it; for a source, prune what it managed and no longer
 * declares, and adopt existing rows with the manifest's name. Each manifest
 * is its own unit: one bad file is one error item, the rest still apply.
 * `dryRun` plans and writes nothing. docs/config-as-code.md.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  MANIFEST_APPLY_ORDER,
  isManifestKind,
  stableStringify,
  uninlinedFileFields,
  type ConfigApplyResult,
  type ConfigApplySummary,
  type ConfigPlanItem,
  type Manifest,
  type ManifestInput,
  type ManifestKind,
} from "@optio/shared";
import { db } from "../../db/client.js";
import { configObjects, configSources } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { ManifestSchema } from "../../schemas/config.js";
import { WorkError } from "../work-write-service.js";
import { loadContext, ManifestError, type ResolveContext, type ResourceTable } from "./context.js";
import { HANDLERS, type Identified } from "./kinds/index.js";

export type ConfigSourceRow = typeof configSources.$inferSelect;
type ObjectRow = typeof configObjects.$inferSelect;

export interface ApplyOptions {
  workspaceId: string | null;
  manifests: ManifestInput[];
  dryRun: boolean;
  /** The source the manifests come from; without one nothing becomes managed. */
  source?: ConfigSourceRow | null;
  /** Delete what the source managed and no longer declares (sources only). */
  prune?: boolean;
  /** Problems found before the apply (files that didn't parse), reported with the rest. */
  priorErrors?: ConfigPlanItem[];
}

interface Parsed {
  path: string;
  manifest: Manifest;
  hash: string;
}

const objectKey = (kind: string, name: string) => `${kind}\u0000${name}`;
const resourceKey = (table: string, id: string) => `${table}:${id}`;

/** A manifest's content hash — what tells a changed file from a changed row. */
export function manifestHash(manifest: unknown): string {
  return createHash("sha256").update(stableStringify(manifest)).digest("hex").slice(0, 16);
}

function emptySummary(): ConfigApplySummary {
  return {
    created: 0,
    updated: 0,
    reverted: 0,
    unchanged: 0,
    adopted: 0,
    replaced: 0,
    pruned: 0,
    errors: 0,
  };
}

function summarize(items: ConfigPlanItem[]): ConfigApplySummary {
  const s = emptySummary();
  for (const item of items) {
    switch (item.action) {
      case "create":
        s.created++;
        break;
      case "update":
        s.updated++;
        if (item.reverted) s.reverted++;
        break;
      case "unchanged":
        s.unchanged++;
        break;
      case "adopt":
        s.adopted++;
        break;
      case "replace":
        s.replaced++;
        break;
      case "prune":
        s.pruned++;
        break;
      case "error":
        s.errors++;
        break;
    }
  }
  return s;
}

/** What a document says it is, for an error about it. */
function labelOf(document: unknown): { kind: string; name: string } {
  const doc = (document ?? {}) as { kind?: unknown; metadata?: { name?: unknown } };
  return {
    kind: typeof doc.kind === "string" ? doc.kind : "?",
    name: typeof doc.metadata?.name === "string" ? doc.metadata.name : "?",
  };
}

function errorItem(input: ManifestInput, message: string): ConfigPlanItem {
  return { ...labelOf(input.document), path: input.path, action: "error", message };
}

/** Validate every input; invalid ones become error items. */
function parse(inputs: ManifestInput[]): { parsed: Parsed[]; items: ConfigPlanItem[] } {
  const parsed: Parsed[] = [];
  const items: ConfigPlanItem[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const left = uninlinedFileFields(input.document);
    if (left.length) {
      items.push(
        errorItem(input, `${left.join(", ")}: file fields must be read in before an apply`),
      );
      continue;
    }
    const result = ManifestSchema.safeParse(input.document);
    if (!result.success) {
      const problems = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "document"}: ${i.message}`)
        .join("; ");
      items.push(errorItem(input, problems));
      continue;
    }
    const manifest = result.data as Manifest;
    const key = objectKey(manifest.kind, manifest.metadata.name);
    if (seen.has(key)) {
      items.push(
        errorItem(input, `${manifest.kind} "${manifest.metadata.name}" is declared more than once`),
      );
      continue;
    }
    seen.add(key);
    parsed.push({ path: input.path, manifest, hash: manifestHash(input.document) });
  }
  return { parsed, items };
}

async function objectsOf(source: ConfigSourceRow | null | undefined): Promise<ObjectRow[]> {
  if (!source) return [];
  return db.select().from(configObjects).where(eq(configObjects.sourceId, source.id));
}

/** The source (any source) that manages a resource, if one does. */
async function managerOf(
  ident: Identified,
): Promise<{ object: ObjectRow; source: ConfigSourceRow } | null> {
  const [found] = await db
    .select({ object: configObjects, source: configSources })
    .from(configObjects)
    .innerJoin(configSources, eq(configSources.id, configObjects.sourceId))
    .where(
      and(eq(configObjects.resourceTable, ident.table), eq(configObjects.resourceId, ident.id)),
    );
  return found ?? null;
}

async function recordObject(
  source: ConfigSourceRow,
  kind: ManifestKind,
  name: string,
  path: string,
  ident: Identified,
  hash: string,
): Promise<void> {
  // The resource may have been managed under another name (a rename in the
  // file): that bookkeeping goes, the new name's row points at the resource.
  await db
    .delete(configObjects)
    .where(
      and(eq(configObjects.resourceTable, ident.table), eq(configObjects.resourceId, ident.id)),
    );
  await db
    .insert(configObjects)
    .values({
      sourceId: source.id,
      workspaceId: source.workspaceId,
      kind,
      name,
      path,
      resourceTable: ident.table,
      resourceId: ident.id,
      hash,
      appliedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [configObjects.sourceId, configObjects.kind, configObjects.name],
      set: {
        path,
        resourceTable: ident.table,
        resourceId: ident.id,
        hash,
        appliedAt: new Date(),
      },
    });
}

function messageOf(err: unknown): string {
  if (err instanceof ManifestError || err instanceof WorkError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  logger.warn({ err }, "config apply: unexpected error applying a manifest");
  return message;
}

async function applyOne(
  p: Parsed,
  ctx: ResolveContext,
  opts: ApplyOptions,
  objects: Map<string, ObjectRow>,
): Promise<{ item: ConfigPlanItem; wrote: boolean }> {
  const { kind } = p.manifest;
  const name = p.manifest.metadata.name;
  const handler = HANDLERS[kind];
  const base = { kind, name, path: p.path };
  const source = opts.source ?? null;
  const object = objects.get(objectKey(kind, name)) ?? null;
  const desired = await handler.desire(p.manifest, ctx);

  let row: unknown = object
    ? await handler.get(object.resourceTable as ResourceTable, object.resourceId, ctx)
    : null;
  let adopted = false;
  if (!row) {
    row = await handler.find(desired, ctx);
    if (row) {
      const ident = handler.identify(row);
      if (ident.ownerUserId) {
        throw new ManifestError(`"${name}" exists, but it is someone's private ${kind}`);
      }
      const manager = await managerOf(ident);
      if (manager && manager.source.id !== source?.id) {
        throw new ManifestError(
          `Already managed by ${manager.source.name} (${manager.object.path})`,
        );
      }
      adopted = !!source && !manager;
    }
  }

  const record = async (r: unknown) => {
    if (source && !opts.dryRun) {
      await recordObject(source, kind, name, p.path, handler.identify(r), p.hash);
    }
  };

  if (!row) {
    if (opts.dryRun) {
      handler.stub?.(desired, ctx);
      return { item: { ...base, action: "create" }, wrote: false };
    }
    const created = await handler.create(desired, ctx);
    await record(created);
    return {
      item: { ...base, action: "create", resourceId: handler.identify(created).id },
      wrote: true,
    };
  }

  const ident = handler.identify(row);
  const reason = handler.replaceReason(row, desired);
  if (reason) {
    if (opts.dryRun) {
      handler.stub?.(desired, ctx);
      return {
        item: { ...base, action: "replace", resourceId: ident.id, message: reason },
        wrote: false,
      };
    }
    await handler.remove(ident.table, ident.id, ctx);
    const created = await handler.create(desired, ctx);
    await record(created);
    return {
      item: {
        ...base,
        action: "replace",
        resourceId: handler.identify(created).id,
        message: reason,
      },
      wrote: true,
    };
  }

  const changes = await handler.diff(row, desired, ctx);
  if (changes.length === 0) {
    await record(row);
    return {
      item: { ...base, action: adopted ? "adopt" : "unchanged", resourceId: ident.id },
      wrote: false,
    };
  }
  // The file is what it was when the row was last written, so the row moved:
  // someone edited it in the UI, and the file wins.
  const reverted = !!object && object.hash === p.hash;
  const item: ConfigPlanItem = {
    ...base,
    action: "update",
    resourceId: ident.id,
    changes,
    ...(reverted ? { reverted } : {}),
    ...(adopted ? { message: "adopted an existing resource with this name" } : {}),
  };
  if (opts.dryRun) return { item, wrote: false };
  const updated = await handler.update(row, desired, ctx);
  await record(updated);
  return { item, wrote: true };
}

/** Make the workspace match the manifests (or, `dryRun`, say what that would take). */
export async function applyManifests(opts: ApplyOptions): Promise<ConfigApplyResult> {
  const { parsed, items } = parse(opts.manifests);
  items.unshift(...(opts.priorErrors ?? []));
  const ctx = await loadContext(opts.workspaceId);
  const objects = new Map(
    (await objectsOf(opts.source)).map((o) => [objectKey(o.kind, o.name), o]),
  );
  const declared = new Set<string>();
  // A manifest that failed still "declares" its name: its resource is not pruned.
  for (const input of opts.manifests) {
    const { kind, name } = labelOf(input.document);
    if (isManifestKind(kind)) declared.add(objectKey(kind, name));
  }

  for (const kind of MANIFEST_APPLY_ORDER) {
    let wrote = false;
    for (const p of parsed.filter((x) => x.manifest.kind === kind)) {
      try {
        const result = await applyOne(p, ctx, opts, objects);
        items.push(result.item);
        wrote ||= result.wrote;
      } catch (err) {
        items.push({
          kind,
          name: p.manifest.metadata.name,
          path: p.path,
          action: "error",
          message: messageOf(err),
        });
      }
    }
    if (wrote) await ctx.reload();
  }

  // Prune (sources only): what the source managed that no manifest declares.
  if (opts.source) {
    const orphans = [...objects.values()].filter((o) => !declared.has(objectKey(o.kind, o.name)));
    for (const o of orphans.sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
    )) {
      const base = { kind: o.kind, name: o.name, path: o.path, resourceId: o.resourceId };
      if (!opts.prune) {
        items.push({ ...base, action: "unchanged", message: "no longer declared; pruning is off" });
        continue;
      }
      if (opts.dryRun) {
        items.push({ ...base, action: "prune" });
        continue;
      }
      try {
        if (isManifestKind(o.kind)) {
          await HANDLERS[o.kind].remove(o.resourceTable as ResourceTable, o.resourceId, ctx);
        }
        await db.delete(configObjects).where(eq(configObjects.id, o.id));
        items.push({ ...base, action: "prune" });
      } catch (err) {
        items.push({ ...base, action: "error", message: `couldn't prune: ${messageOf(err)}` });
      }
    }
  }

  return {
    dryRun: opts.dryRun,
    source: opts.source ? { id: opts.source.id, name: opts.source.name } : null,
    items,
    summary: summarize(items),
    at: new Date().toISOString(),
  };
}

/** Stop managing one resource: its bookkeeping goes, the resource stays. */
export async function detachObject(objectId: string, workspaceId: string | null): Promise<boolean> {
  const deleted = await db
    .delete(configObjects)
    .where(
      and(
        eq(configObjects.id, objectId),
        workspaceId ? eq(configObjects.workspaceId, workspaceId) : undefined,
      ),
    )
    .returning({ id: configObjects.id });
  return deleted.length > 0;
}
