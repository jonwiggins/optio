/**
 * After a database restore (scripts/backup/restore-db.sh;
 * docs/backup.md) — does this deployment's encryption key
 * (OPTIO_ENCRYPTION_KEY) open the values sealed in the restored database?
 * A dump is only good together with the key it was made with: restored under
 * another key, every token, connection and sign-in secret in it is noise, and
 * Optio fails one run at a time. This says so at once.
 *
 * It tries every kind of sealed value the API stores (SEALED_SOURCES, from
 * the one list in encrypted-columns.ts): the stored tokens (`secrets`) and
 * the secrets sealed on their own rows (model providers, connections,
 * webhooks, repos, sign-in, remote workspaces), each with the AAD its service
 * seals it with. "Nothing to check" is said only when none of them holds
 * anything.
 *
 * `scripts/check-encryption-key.ts` runs it in the API pod: against the live
 * database after a restore (and records the restore in the action log), or
 * against a drill's database next to it (and drops that afterwards — only a
 * database a drill made, DRILL_DATABASE_MARK).
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.js";
import { parseSslConfig } from "../db/ssl.js";
import {
  ENCRYPTED_COLUMNS,
  KEY_CHECK_SOURCE_LIMIT,
  STORED_TOKENS,
  readSealedRows,
  storedTokenAads,
} from "./encrypted-columns.js";
import { logAction } from "./optio-action-service.js";
import { ALG_AES_256_GCM_V1, decrypt } from "./secret-service.js";

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

interface SourceCount {
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
/** A `secrets` row as a sealed value. */
function storedTokenValue(row: StoredSecretRow): SealedValue {
  return {
    source: STORED_TOKENS,
    label: `${row.name} (${row.scope})`,
    alg: row.alg,
    iv: row.iv,
    ciphertext: row.encryptedValue,
    authTag: row.authTag,
    aads: storedTokenAads(row),
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

interface SealedSource {
  label: string;
  read: (db: Db, limit: number) => Promise<SealedValue[]>;
}

/**
 * Every kind of sealed value (encrypted-columns.ts ENCRYPTED_COLUMNS), each
 * with the AADs its service seals it with. Stored tokens are read up to
 * KEY_CHECK_ROW_LIMIT, the others up to the limit the check asks for.
 */
export const SEALED_SOURCES: readonly SealedSource[] = ENCRYPTED_COLUMNS.map((column) => ({
  label: column.label,
  read: async (db: Db, limit: number) =>
    (await readSealedRows(db, column, { limit: column.checkLimit ?? limit })).flatMap(
      ({ row, blob }) =>
        blob
          ? [
              {
                source: column.label,
                label: column.what(row),
                alg: blob.alg,
                iv: blob.iv,
                ciphertext: blob.ciphertext,
                authTag: blob.authTag,
                aads: column.aads(row),
              },
            ]
          : [],
    ),
}));

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
 * The restore in the action log (`optio_actions`): with no workspace and no
 * person (an operator's action, shown to admins only), naming the dump and
 * where the database as it was is kept. The names go in `result`: `params`
 * keeps only its allow-listed fields. Everything else the log held since the
 * dump went with the restore.
 */
export async function recordRestore(input: { dump: string; keptAs?: string | null }) {
  await logAction({
    action: "database.restored",
    workspaceId: null,
    result: { dump: input.dump, ...(input.keptAs ? { keptAs: input.keptAs } : {}) },
    success: true,
  });
}
