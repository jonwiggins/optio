/**
 * Every value Optio seals with the encryption key (secret-service `encrypt`)
 * and keeps in the database: the table, its blob columns and the AAD its
 * service seals it with. The restore check (database-restore-check.ts) and
 * key rotation (encryption-key-rotation.ts, scripts/rotate-encryption-key.ts)
 * both read this one list, so a feature that adds a sealed column adds one
 * entry here and both cover it. database-restore-check.int.test.ts seals a
 * value through each service and checks it opens with the AADs named here,
 * so the two sides can't drift apart unnoticed.
 *
 * The tables are resolved when a list is read (`columns()`), not when this
 * module loads.
 */
import { and, asc, gt, isNotNull, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgDatabase, PgTable } from "drizzle-orm/pg-core";
import {
  authProviderConfigs,
  connections,
  modelProviders,
  remoteWorkspaceConnections,
  repos,
  secrets,
  webhooks,
} from "../db/schema.js";
import { ALG_AES_256_GCM_V1, buildSecretAAD } from "./secret-service.js";

/** Where a sealed value lives. */
interface EncryptedColumnRefs<F extends Record<string, AnyPgColumn>> {
  table: PgTable;
  /** The primary key: unique and ordered, so a batch can start after the last one. */
  id: AnyPgColumn;
  ciphertext: AnyPgColumn;
  iv: AnyPgColumn;
  authTag: AnyPgColumn;
  /** The algorithm id column, for tables that have one (others are AES-256-GCM v1). */
  alg?: AnyPgColumn;
  /** Further columns `what` and `aads` read. */
  fields: F;
}

type FieldValues<F extends Record<string, AnyPgColumn>> = {
  [K in keyof F]: F[K]["_"]["data"] | null;
};

/** A row's identity and its further columns, as `what` and `aads` see it. */
type EncryptedRow<F extends Record<string, AnyPgColumn>> = FieldValues<F> & { id: string };

interface EncryptedColumnDefinition<F extends Record<string, AnyPgColumn>> {
  /** The kind of value, as the restore check and the rotation report name it. */
  label: string;
  columns: () => EncryptedColumnRefs<F>;
  /** What one value is, for reports (never the value). */
  what: (row: EncryptedRow<F>) => string;
  /**
   * The AADs a value may be sealed with, the one the service seals with now
   * first. A rotation re-seals each value with the AAD it opened with.
   */
  aads: (row: EncryptedRow<F>) => Buffer[];
  /**
   * The AAD a legacy value (16-byte IV, sealed without an AAD, which opens
   * under any) is re-sealed with. Default: the first of `aads`.
   */
  legacyAad?: (row: EncryptedRow<F>) => Buffer;
  /** How many the restore check reads (default 50). */
  checkLimit?: number;
}

/** A registry entry with its row type erased. */
export type EncryptedColumn = EncryptedColumnDefinition<Record<string, AnyPgColumn>>;

/** Declare one sealed column (typed against its own fields). */
function encryptedColumn<F extends Record<string, AnyPgColumn>>(
  definition: EncryptedColumnDefinition<F>,
): EncryptedColumn {
  return definition as unknown as EncryptedColumn;
}

/** How many stored tokens the restore check reads: enough to tell a wrong key from a few damaged rows. */
const KEY_CHECK_ROW_LIMIT = 1000;
/** How many of each other kind of sealed value the restore check reads. */
export const KEY_CHECK_SOURCE_LIMIT = 50;

export const STORED_TOKENS = "stored tokens";

/**
 * The AADs a stored token may have been sealed with: as `storeSecret` builds
 * it now (a global or a private secret is never workspace-bound), then as the
 * row says (a row stored before a heal fixed its binding).
 */
export function storedTokenAads(row: {
  name: string;
  scope: string;
  workspaceId: string | null;
}): Buffer[] {
  const bound = row.scope === "global" || row.scope === "user" ? null : row.workspaceId;
  const out = [buildSecretAAD(row.name, row.scope, bound)];
  if (bound !== row.workspaceId) out.push(buildSecretAAD(row.name, row.scope, row.workspaceId));
  return out;
}

/**
 * Every sealed column. A PR that adds one appends an entry here (with the
 * same AAD as its service) and a value of it to the seeding in
 * database-restore-check.int.test.ts and encryption-key-rotation.int.test.ts.
 */
export const ENCRYPTED_COLUMNS: readonly EncryptedColumn[] = [
  // secret-service.ts storeSecret / retrieveSecret
  encryptedColumn({
    label: STORED_TOKENS,
    checkLimit: KEY_CHECK_ROW_LIMIT,
    columns: () => ({
      table: secrets,
      id: secrets.id,
      ciphertext: secrets.encryptedValue,
      iv: secrets.iv,
      authTag: secrets.authTag,
      alg: secrets.alg,
      fields: { name: secrets.name, scope: secrets.scope, workspaceId: secrets.workspaceId },
    }),
    what: (r) => `${r.name} (${r.scope})`,
    aads: (r) => storedTokenAads({ name: r.name!, scope: r.scope!, workspaceId: r.workspaceId }),
    // A legacy row is read with its own binding (and healed from it at boot).
    legacyAad: (r) => buildSecretAAD(r.name!, r.scope!, r.workspaceId),
  }),
  // model-provider-service.ts credentialsAAD
  encryptedColumn({
    label: "model provider credentials",
    columns: () => ({
      table: modelProviders,
      id: modelProviders.id,
      ciphertext: modelProviders.encryptedCredentials,
      iv: modelProviders.credentialsIv,
      authTag: modelProviders.credentialsAuthTag,
      fields: { name: modelProviders.name },
    }),
    what: (r) => `model provider ${r.name}`,
    aads: (r) => [Buffer.from(`model_provider|${r.id}`)],
  }),
  // connection-service.ts secretConfigAAD
  encryptedColumn({
    label: "connection secrets",
    columns: () => ({
      table: connections,
      id: connections.id,
      ciphertext: connections.secretConfig,
      iv: connections.secretConfigIv,
      authTag: connections.secretConfigAuthTag,
      fields: { name: connections.name },
    }),
    what: (r) => `connection ${r.name}`,
    aads: (r) => [Buffer.from(`connection|${r.id}`)],
  }),
  // webhook-service.ts createWebhook / decryptWebhookRow
  encryptedColumn({
    label: "webhook signing secrets",
    columns: () => ({
      table: webhooks,
      id: webhooks.id,
      ciphertext: webhooks.encryptedSecret,
      iv: webhooks.secretIv,
      authTag: webhooks.secretAuthTag,
      alg: webhooks.secretAlg,
      fields: { url: webhooks.url },
    }),
    what: (r) => `webhook ${r.id}`,
    aads: (r) => [Buffer.from(`webhook:${r.url}:secret`)],
  }),
  // repo-service.ts updateRepo / decryptRepoRow
  encryptedColumn({
    label: "repo Slack webhooks",
    columns: () => ({
      table: repos,
      id: repos.id,
      ciphertext: repos.encryptedSlackWebhookUrl,
      iv: repos.slackWebhookUrlIv,
      authTag: repos.slackWebhookUrlAuthTag,
      alg: repos.slackWebhookUrlAlg,
      fields: { name: repos.fullName },
    }),
    what: (r) => `repo ${r.name} (Slack webhook)`,
    aads: (r) => [Buffer.from(`repo:${r.id}:slackWebhookUrl`)],
  }),
  // sign-in-config-service.ts secretAAD
  encryptedColumn({
    label: "sign-in secrets",
    columns: () => ({
      table: authProviderConfigs,
      id: authProviderConfigs.provider,
      ciphertext: authProviderConfigs.encryptedClientSecret,
      iv: authProviderConfigs.clientSecretIv,
      authTag: authProviderConfigs.clientSecretAuthTag,
      fields: {},
    }),
    what: (r) => `sign-in ${r.id} secret`,
    aads: (r) => [Buffer.from(`auth_provider|${r.id}`)],
  }),
  // remote-workspace-service.ts tokenAAD
  encryptedColumn({
    label: "remote workspace tokens",
    columns: () => ({
      table: remoteWorkspaceConnections,
      id: remoteWorkspaceConnections.id,
      ciphertext: remoteWorkspaceConnections.encryptedToken,
      iv: remoteWorkspaceConnections.tokenIv,
      authTag: remoteWorkspaceConnections.tokenAuthTag,
      fields: {
        provider: remoteWorkspaceConnections.provider,
        name: remoteWorkspaceConnections.name,
      },
    }),
    what: (r) => `${r.provider} connection ${r.name}`,
    aads: (r) => [Buffer.from(`coder_connection|${r.id}`)],
  }),
];

/** One sealed value as read: its row (for `what` / `aads`) and its blob. */
export interface SealedRow {
  row: EncryptedRow<Record<string, AnyPgColumn>>;
  /** Null when part of the blob is missing (a damaged row). */
  blob: { alg: number; iv: Buffer; ciphertext: Buffer; authTag: Buffer } | null;
}

/** Any drizzle Postgres database or transaction. */
export type SealedDb = PgDatabase<any, any, any>;

/**
 * Read the sealed values of one column: those with a ciphertext, in primary
 * key order, after `after` (exclusive) when given, at most `limit`;
 * `forUpdate` locks them until the transaction ends.
 */
export async function readSealedRows(
  db: SealedDb,
  column: EncryptedColumn,
  options: { limit: number; after?: string | null; forUpdate?: boolean },
): Promise<SealedRow[]> {
  const refs = column.columns();
  const conditions: SQL[] = [isNotNull(refs.ciphertext)];
  if (options.after != null) conditions.push(gt(refs.id, options.after));
  const selection: Record<string, AnyPgColumn> = {
    ...refs.fields,
    __id: refs.id,
    __ct: refs.ciphertext,
    __iv: refs.iv,
    __tag: refs.authTag,
    ...(refs.alg ? { __alg: refs.alg } : {}),
  };
  const query = db
    .select(selection)
    .from(refs.table)
    .where(and(...conditions))
    .orderBy(asc(refs.id))
    .limit(options.limit);
  const rows = (await (options.forUpdate ? query.for("update") : query)) as Record<
    string,
    unknown
  >[];
  return rows.map((r) => {
    const { __id, __ct, __iv, __tag, __alg, ...fields } = r;
    const ct = __ct as Buffer | null;
    const iv = __iv as Buffer | null;
    const tag = __tag as Buffer | null;
    return {
      row: { ...fields, id: String(__id) },
      blob:
        ct && iv && tag
          ? {
              alg: (__alg as number | null | undefined) ?? ALG_AES_256_GCM_V1,
              iv,
              ciphertext: ct,
              authTag: tag,
            }
          : null,
    };
  });
}
