/**
 * One handler per manifest kind: how a manifest becomes the rows it
 * describes (`desire`), which row it names (`find`), whether that row already
 * matches (`diff`), and how to create, update, remove and export one. The
 * apply engine (services/config/apply.ts) is generic over these.
 */
import type { Manifest, ManifestKind } from "@optio/shared";
import type { ResolveContext, ResourceTable } from "../context.js";
import { workHandler } from "./work.js";
import { promptHandler } from "./prompt.js";
import { repoHandler } from "./repo.js";
import { mcpServerHandler } from "./mcp-server.js";
import { skillHandler } from "./skill.js";
import { connectionHandler } from "./connection.js";

/** Which row a handler's value is. */
export interface Identified {
  table: ResourceTable;
  id: string;
  name: string;
  /** Set when the row is someone's private one (a manifest can't manage those). */
  ownerUserId: string | null;
}

export interface KindHandler<M extends Manifest, D extends { name: string }, R> {
  kind: ManifestKind;
  /** Resolve the manifest (names → ids, defaults) or throw `ManifestError`. */
  desire(manifest: M, ctx: ResolveContext): Promise<D>;
  /** The table the desired rows live in. */
  tableOf(desired: D): ResourceTable;
  /** The existing row the manifest names in this workspace, if any (what an apply adopts). */
  find(desired: D, ctx: ResolveContext): Promise<R | null>;
  /** A managed row by its bookkeeping (null when it was deleted by hand). */
  get(table: ResourceTable, id: string, ctx: ResolveContext): Promise<R | null>;
  identify(row: R): Identified;
  /** Why `row` can't be updated into `desired` and has to be recreated, or null. */
  replaceReason(row: R, desired: D): string | null;
  /**
   * A dry run writes nothing, so a manifest applied later that names this one
   * (a Work's connection, a Connection's repo) would not resolve: register
   * the would-be row in the context under its name, with a placeholder id.
   */
  stub?(desired: D, ctx: ResolveContext): void;
  /** The fields that differ ([] = the row already matches). */
  diff(row: R, desired: D, ctx: ResolveContext): Promise<string[]>;
  create(desired: D, ctx: ResolveContext): Promise<R>;
  update(row: R, desired: D, ctx: ResolveContext): Promise<R>;
  remove(table: ResourceTable, id: string, ctx: ResolveContext): Promise<void>;
  /** The organization's rows of this kind in the workspace (for an export). */
  list(ctx: ResolveContext): Promise<R[]>;
  export(row: R, ctx: ResolveContext): Promise<M>;
}

export type AnyHandler = KindHandler<Manifest, { name: string }, unknown>;

const h = (handler: unknown) => handler as AnyHandler;

export const HANDLERS: Record<ManifestKind, AnyHandler> = {
  Work: h(workHandler),
  Prompt: h(promptHandler),
  Repo: h(repoHandler),
  McpServer: h(mcpServerHandler),
  Skill: h(skillHandler),
  Connection: h(connectionHandler),
};
