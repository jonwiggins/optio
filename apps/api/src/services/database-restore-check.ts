/**
 * After a database restore (scripts/backup/restore-db.sh;
 * docs/backup.md) — does this deployment's encryption key
 * (OPTIO_ENCRYPTION_KEY) open the values sealed in the restored database?
 * A dump is only good together with the key it was made with: restored under
 * another key, every token, connection and sign-in secret in it is noise, and
 * Optio fails one run at a time. This says so at once.
 *
 * It tries every kind of sealed value the API stores (SEALED_SOURCES): the
 * stored tokens (`secrets`) and the secrets sealed on their own rows
 * (gateways, connections, webhooks, repos, remote workspaces, sign-in, the SMTP relay),
 * each with the AAD its service seals it with. "Nothing to check" is said
 * only when none of them holds anything.
 *
 * `scripts/check-encryption-key.ts` runs it in the API pod: against the live
 * database after a restore (and records the restore in the audit trail), or
 * against a drill's database next to it (and drops that afterwards — only a
 * database a drill made, DRILL_DATABASE_MARK).
 */
import { isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.js";
import {
  authProviderConfigs,
  connections,
  modelProviders,
  notifySmtpSettings,
  remoteWorkspaceConnections,
  repos,
  secrets,
  webhooks,
} from "../db/schema.js";
import { parseSslConfig } from "../db/ssl.js";
import { auditEvent } from "./audit.js";
import { ALG_AES_256_GCM_V1, buildSecretAAD, decrypt } from "./secret-service.js";

/** A `secrets` row as the check reads it. */
export interface StoredSecretRow {
  name: string;
  scope: string;
  workspaceId: string | null;
  alg: number | null;
  iv: Buffer;
  encryptedValue: Buffer;
  authTag: Buffer;
}

/** One sealed value: its blob, and the AADs it may have been sealed with. */
export interface SealedValue {
  /** The kind of value (a SEALED_SOURCES label). */
  source: string;
  /** What it is, for the list of values that didn't open (never the value). */
  label: string;
  alg: number | null;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
  aads: Buffer[];
}

export interface SourceCount {
  source: string;
  checked: number;
  opened: number;
}

export interface KeyCheckResult {
  /** Values looked at. */
  checked: number;
  /** Values the key opened. */
  opened: number;
  /** Labels of the values it didn't open, at most `MAX_NAMED`. */
  failed: string[];
  /** ok: it opens them; empty: nothing sealed to check; wrong-key: it opens none. */
  verdict: "ok" | "empty" | "wrong-key";
  /** Per kind of value, the ones there are. */
  sources: SourceCount[];
}

const MAX_NAMED = 10;
/** How many stored tokens are read: enough to tell a wrong key from a few damaged rows. */
export const KEY_CHECK_ROW_LIMIT = 1000;
/** How many of each other kind of sealed value are read. */
export const KEY_CHECK_SOURCE_LIMIT = 50;

/**
 * The AADs a stored token may have been sealed with: as `storeSecret` builds
 * it now (a global or a private secret is never workspace-bound), then as the
 * row says (a row stored before a heal fixed its binding).
 */
function aadsFor(row: StoredSecretRow): Buffer[] {
  const bound = row.scope === "global" || row.scope === "user" ? null : row.workspaceId;
  const out = [buildSecretAAD(row.name, row.scope, bound)];
  if (bound !== row.workspaceId) out.push(buildSecretAAD(row.name, row.scope, row.workspaceId));
  return out;
}

export const STORED_TOKENS = "stored tokens";

/** A `secrets` row as a sealed value. */
export function storedTokenValue(row: StoredSecretRow): SealedValue {
  return {
    source: STORED_TOKENS,
    label: `${row.name} (${row.scope})`,
    alg: row.alg,
    iv: row.iv,
    ciphertext: row.encryptedValue,
    authTag: row.authTag,
    aads: aadsFor(row),
  };
}

function opens(value: SealedValue): boolean {
  for (const aad of value.aads) {
    try {
      decrypt(
        {
          alg: value.alg ?? ALG_AES_256_GCM_V1,
          iv: value.iv,
          ciphertext: value.ciphertext,
          authTag: value.authTag,
        },
        aad,
        value.label,
      );
      return true;
    } catch {
      // the next binding, or not opened
    }
  }
  return false;
}

/** Try the key (OPTIO_ENCRYPTION_KEY) on each value. Never returns or logs a value. */
export function checkKeyOnValues(values: readonly SealedValue[]): KeyCheckResult {
  let opened = 0;
  const failed: string[] = [];
  const bySource = new Map<string, SourceCount>();
  for (const value of values) {
    const count = bySource.get(value.source) ?? { source: value.source, checked: 0, opened: 0 };
    bySource.set(value.source, count);
    count.checked++;
    if (opens(value)) {
      opened++;
      count.opened++;
    } else if (failed.length < MAX_NAMED) failed.push(value.label);
  }
  const verdict = values.length === 0 ? "empty" : opened === 0 ? "wrong-key" : "ok";
  return { checked: values.length, opened, failed, verdict, sources: [...bySource.values()] };
}

/** Try the key on stored tokens (`secrets` rows). */
export function checkKeyOnRows(rows: readonly StoredSecretRow[]): KeyCheckResult {
  return checkKeyOnValues(rows.map(storedTokenValue));
}

const PLAIN_DB = /^[a-z_][a-z0-9_]{0,62}$/;

/** The database a postgres:// URL names. */
export function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/** The same URL (credentials, TLS settings) naming another database. */
export function databaseUrlFor(url: string, database: string): string {
  if (!PLAIN_DB.test(database)) {
    throw new Error(`Not a plain database name (lower-case letters, digits, _): ${database}`);
  }
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** A short-lived connection to `url`, with the TLS the API itself would use. */
export function connectTo(url: string) {
  const ssl = parseSslConfig(url);
  const u = new URL(url);
  // postgres-js sends unknown query parameters to the server; libpq's ssl* aren't its.
  for (const k of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) u.searchParams.delete(k);
  const client = postgres(u.toString(), { max: 1, ...(ssl ? { ssl } : {}) });
  return { db: drizzle(client, { schema }), close: () => client.end({ timeout: 5 }) };
}

type Db = ReturnType<typeof connectTo>["db"];

/** PostgreSQL's code for an error drizzle wraps (DrizzleQueryError.cause) or postgres-js throws. */
function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

/** No such table or column: a drill's database restored from an older dump. */
function notInThisDatabase(err: unknown): boolean {
  const code = pgCode(err);
  return code === "42P01" || code === "42703";
}

/** The error's own message: drizzle's names the query; PostgreSQL's says why. */
export function errorText(err: unknown): string {
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return err instanceof Error ? err.message : String(err);
}

/** A sealed column of a row, as a select names it: its blob (any part may be null). */
interface SealedColumn {
  ct: Buffer | null;
  iv: Buffer | null;
  tag: Buffer | null;
  alg?: number | null;
}

interface SealedSource {
  label: string;
  read: (db: Db, limit: number) => Promise<SealedValue[]>;
}

/** A kind of value sealed on its own rows, each with the one AAD its service seals it with. */
function rowSource<R extends SealedColumn>(
  label: string,
  rows: (db: Db, limit: number) => Promise<R[]>,
  what: (row: R) => string,
  aad: (row: R) => string,
): SealedSource {
  return {
    label,
    read: async (db, limit) =>
      (await rows(db, limit)).flatMap((r) =>
        r.ct && r.iv && r.tag
          ? [
              {
                source: label,
                label: what(r),
                alg: r.alg ?? ALG_AES_256_GCM_V1,
                iv: r.iv,
                ciphertext: r.ct,
                authTag: r.tag,
                aads: [Buffer.from(aad(r))],
              },
            ]
          : [],
      ),
  };
}

/**
 * Every kind of sealed value, as each service seals it. The AADs mirror the
 * services' own (named next to each): database-restore-check.int.test.ts
 * seals a value through each service and checks it opens here, so a change
 * on one side fails there.
 */
export const SEALED_SOURCES: readonly SealedSource[] = [
  {
    label: STORED_TOKENS,
    read: async (db) =>
      (
        await db
          .select({
            name: secrets.name,
            scope: secrets.scope,
            workspaceId: secrets.workspaceId,
            alg: secrets.alg,
            iv: secrets.iv,
            encryptedValue: secrets.encryptedValue,
            authTag: secrets.authTag,
          })
          .from(secrets)
          .limit(KEY_CHECK_ROW_LIMIT)
      ).map(storedTokenValue),
  },
  // model-provider-service.ts credentialsAAD
  rowSource(
    "model provider credentials",
    (db, limit) =>
      db
        .select({
          id: modelProviders.id,
          name: modelProviders.name,
          ct: modelProviders.encryptedCredentials,
          iv: modelProviders.credentialsIv,
          tag: modelProviders.credentialsAuthTag,
        })
        .from(modelProviders)
        .where(isNotNull(modelProviders.encryptedCredentials))
        .limit(limit),
    (r) => `model provider ${r.name}`,
    (r) => `model_provider|${r.id}`,
  ),
  // gateway-keys.ts adminKeyAAD
  rowSource(
    "gateway admin keys",
    (db, limit) =>
      db
        .select({
          id: modelProviders.id,
          name: modelProviders.name,
          ct: modelProviders.encryptedAdminKey,
          iv: modelProviders.adminKeyIv,
          tag: modelProviders.adminKeyAuthTag,
        })
        .from(modelProviders)
        .where(isNotNull(modelProviders.encryptedAdminKey))
        .limit(limit),
    (r) => `gateway ${r.name} (admin key)`,
    (r) => `model_provider_admin_key|${r.id}`,
  ),
  // connection-service.ts secretConfigAAD
  rowSource(
    "connection secrets",
    (db, limit) =>
      db
        .select({
          id: connections.id,
          name: connections.name,
          ct: connections.secretConfig,
          iv: connections.secretConfigIv,
          tag: connections.secretConfigAuthTag,
        })
        .from(connections)
        .where(isNotNull(connections.secretConfig))
        .limit(limit),
    (r) => `connection ${r.name}`,
    (r) => `connection|${r.id}`,
  ),
  // webhook-service.ts createWebhook / decryptWebhookRow
  rowSource(
    "webhook signing secrets",
    (db, limit) =>
      db
        .select({
          id: webhooks.id,
          url: webhooks.url,
          alg: webhooks.secretAlg,
          ct: webhooks.encryptedSecret,
          iv: webhooks.secretIv,
          tag: webhooks.secretAuthTag,
        })
        .from(webhooks)
        .where(isNotNull(webhooks.encryptedSecret))
        .limit(limit),
    (r) => `webhook ${r.id}`,
    (r) => `webhook:${r.url}:secret`,
  ),
  // repo-service.ts updateRepo / decryptRepoRow
  rowSource(
    "repo Slack webhooks",
    (db, limit) =>
      db
        .select({
          id: repos.id,
          name: repos.fullName,
          alg: repos.slackWebhookUrlAlg,
          ct: repos.encryptedSlackWebhookUrl,
          iv: repos.slackWebhookUrlIv,
          tag: repos.slackWebhookUrlAuthTag,
        })
        .from(repos)
        .where(isNotNull(repos.encryptedSlackWebhookUrl))
        .limit(limit),
    (r) => `repo ${r.name} (Slack webhook)`,
    (r) => `repo:${r.id}:slackWebhookUrl`,
  ),
  // remote-workspace-service.ts tokenAAD
  rowSource(
    "remote-workspace tokens",
    (db, limit) =>
      db
        .select({
          id: remoteWorkspaceConnections.id,
          name: remoteWorkspaceConnections.name,
          ct: remoteWorkspaceConnections.encryptedToken,
          iv: remoteWorkspaceConnections.tokenIv,
          tag: remoteWorkspaceConnections.tokenAuthTag,
        })
        .from(remoteWorkspaceConnections)
        .where(isNotNull(remoteWorkspaceConnections.encryptedToken))
        .limit(limit),
    (r) => `remote-workspace connection ${r.name}`,
    (r) => `coder_connection|${r.id}`,
  ),
  // sign-in-config-service.ts secretAAD
  rowSource(
    "sign-in secrets",
    (db, limit) =>
      db
        .select({
          provider: authProviderConfigs.provider,
          ct: authProviderConfigs.encryptedClientSecret,
          iv: authProviderConfigs.clientSecretIv,
          tag: authProviderConfigs.clientSecretAuthTag,
        })
        .from(authProviderConfigs)
        .where(isNotNull(authProviderConfigs.encryptedClientSecret))
        .limit(limit),
    (r) => `sign-in ${r.provider} secret`,
    (r) => `auth_provider|${r.provider}`,
  ),
  // notify/smtp-config.ts AAD
  rowSource(
    "SMTP relay password",
    (db, limit) =>
      db
        .select({
          ct: notifySmtpSettings.encryptedPassword,
          iv: notifySmtpSettings.passwordIv,
          tag: notifySmtpSettings.passwordAuthTag,
        })
        .from(notifySmtpSettings)
        .where(isNotNull(notifySmtpSettings.encryptedPassword))
        .limit(limit),
    () => "the SMTP relay's password",
    () => "notify_smtp|default",
  ),
];

/**
 * The key against the values sealed in the database at `url`. A kind whose
 * table or column the database doesn't have (a drill of an older dump) is
 * left out; any other error is thrown.
 */
export async function checkEncryptionKeyAt(url: string): Promise<KeyCheckResult> {
  const { db, close } = connectTo(url);
  try {
    const values: SealedValue[] = [];
    for (const source of SEALED_SOURCES) {
      try {
        values.push(...(await source.read(db, KEY_CHECK_SOURCE_LIMIT)));
      } catch (err) {
        if (!notInThisDatabase(err)) throw err;
      }
    }
    return checkKeyOnValues(values);
  } finally {
    await close();
  }
}

/**
 * The comment a drill's database carries (helm/optio/files/optio-backup.sh
 * DRILL_MARK sets it when the drill makes the database). Only a database
 * with it is ever dropped as a drill's.
 */
export const DRILL_DATABASE_MARK = "optio restore drill";

/** The names a restore gives the database it keeps and the one it makes. */
const RESTORE_MADE = /_(before|restore)_/;

/**
 * Why `database` can't be a drill's database to drop, or null: the live
 * database, a name a restore gives (…_before_…, …_restore_…), a name that
 * isn't plain.
 */
export function notADrillDatabase(liveUrl: string, database: string): string | null {
  if (!PLAIN_DB.test(database)) {
    return `Not a plain database name (lower-case letters, digits, _): ${database}`;
  }
  if (database === databaseOf(liveUrl)) {
    return `${database} is the live database; a drill's database is another one`;
  }
  if (RESTORE_MADE.test(database)) {
    return `${database} is named like a database a restore keeps or makes (…_before_…, …_restore_…); a drill's database never is`;
  }
  return null;
}

/**
 * A connection to a database on the same server that isn't the live one, to
 * drop another from: `postgres`, else `template1` (as the backup job does),
 * for an account that may not connect to `postgres`.
 */
async function maintenanceConnection(liveUrl: string) {
  let first: unknown;
  for (const name of ["postgres", "template1"]) {
    const conn = connectTo(databaseUrlFor(liveUrl, name));
    try {
      await conn.db.execute(sql`SELECT 1`);
      return conn;
    } catch (err) {
      first ??= err;
      await conn.close().catch(() => undefined);
    }
  }
  throw first;
}

/**
 * Drop a drill's database. Only one a drill made (it carries
 * DRILL_DATABASE_MARK): never the live database, a restore's kept one, or
 * anyone else's on the same server. False when there is none of that name.
 */
export async function dropDrillDatabase(liveUrl: string, database: string): Promise<boolean> {
  const refusal = notADrillDatabase(liveUrl, database);
  if (refusal) throw new Error(refusal);
  const { db, close } = await maintenanceConnection(liveUrl);
  try {
    const rows = await db.execute<{ mark: string | null }>(
      sql`SELECT shobj_description(oid, 'pg_database') AS mark FROM pg_database WHERE datname = ${database}`,
    );
    if (rows.length === 0) return false;
    if (!(rows[0].mark ?? "").startsWith(DRILL_DATABASE_MARK)) {
      throw new Error(
        `${database} wasn't made by a restore drill (its comment isn't "${DRILL_DATABASE_MARK} …"): it is left as it is`,
      );
    }
    // notADrillDatabase checked the name: letters, digits and _ only.
    await db.execute(sql.raw(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`));
    return true;
  } finally {
    await close();
  }
}

/**
 * The restore in the audit trail: deployment-wide (deployment admins read
 * it), by Optio, naming the dump and where the database as it was is kept.
 * Everything else the trail held since the dump went with the restore.
 */
export async function recordRestore(input: { dump: string; keptAs?: string | null }) {
  await auditEvent({
    action: "database.restored",
    userId: null,
    workspaceId: null,
    details: { dump: input.dump, keptAs: input.keptAs ?? undefined },
  });
}
