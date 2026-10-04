/**
 * `managedBy` on a row: which configuration source manages it and from which
 * file. One query per list; rows nobody manages are returned as they are
 * (like `withOwnerNames` leaves the organization's rows alone).
 */
import { and, eq, inArray } from "drizzle-orm";
import type { ManagedBy, WorkSource } from "@optio/shared";
import { db } from "../../db/client.js";
import { configObjects, configSources } from "../../db/schema.js";
import type { ResourceTable } from "./context.js";
import { envConfigSource } from "./env.js";

/** Which table a Work list row's resource lives in (none for runs and sessions). */
export const WORK_SOURCE_TABLE: Partial<Record<WorkSource, ResourceTable>> = {
  "repo-blueprint": "work_definitions",
  standalone: "work_definitions",
  "local-blueprint": "work_definitions",
  "persistent-agent": "persistent_agents",
};

export async function managedByMap(
  table: ResourceTable,
  ids: string[],
): Promise<Map<string, ManagedBy>> {
  const unique = [...new Set(ids)].filter(Boolean);
  // Only the configuration directory manages rows: with it off there is
  // nothing to look up (and no query, which keeps mocked route tests honest).
  if (unique.length === 0 || !envConfigSource()) return new Map();
  const rows = await db
    .select({
      objectId: configObjects.id,
      resourceId: configObjects.resourceId,
      kind: configObjects.kind,
      path: configObjects.path,
      sourceId: configSources.id,
      sourceName: configSources.name,
    })
    .from(configObjects)
    .innerJoin(configSources, eq(configSources.id, configObjects.sourceId))
    .where(and(eq(configObjects.resourceTable, table), inArray(configObjects.resourceId, unique)));
  return new Map(
    rows.map((r) => [
      r.resourceId,
      {
        objectId: r.objectId,
        sourceId: r.sourceId,
        sourceName: r.sourceName,
        path: r.path,
        kind: r.kind,
      },
    ]),
  );
}

/** Decorate the managed rows with `managedBy`; the rest are returned as they are. */
export async function withManagedBy<T extends { id: string }>(
  rows: T[],
  table: ResourceTable,
): Promise<Array<T & { managedBy?: ManagedBy }>> {
  const managed = await managedByMap(
    table,
    rows.map((r) => r.id),
  );
  if (managed.size === 0) return rows;
  return rows.map((r) => {
    const by = managed.get(r.id);
    return by ? { ...r, managedBy: by } : r;
  });
}

/** `withManagedBy` for Work list rows, whose resources live in different tables. */
export async function withManagedWork<T extends { source: WorkSource; id: string }>(
  rows: T[],
): Promise<Array<T & { managedBy?: ManagedBy }>> {
  const byTable = new Map<ResourceTable, string[]>();
  for (const r of rows) {
    const table = WORK_SOURCE_TABLE[r.source];
    if (table) byTable.set(table, [...(byTable.get(table) ?? []), r.id]);
  }
  const maps = await Promise.all(
    [...byTable.entries()].map(
      async ([table, ids]) => [table, await managedByMap(table, ids)] as const,
    ),
  );
  const lookup = new Map(maps);
  return rows.map((r) => {
    const table = WORK_SOURCE_TABLE[r.source];
    const by = table ? lookup.get(table)?.get(r.id) : undefined;
    return by ? { ...r, managedBy: by } : r;
  });
}
