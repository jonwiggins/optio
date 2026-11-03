/**
 * Encryption key rotation (scripts/rotate-encryption-key.ts; the runbook is
 * in docs/cryptography.md): re-seal every value in the database that is
 * still under the previous key (OPTIO_ENCRYPTION_KEY_PREVIOUS) with the
 * current one (OPTIO_ENCRYPTION_KEY), then check that none is left under the
 * previous key.
 *
 * It walks every sealed column in encrypted-columns.ts ENCRYPTED_COLUMNS, in
 * primary key order and in batches. Each batch is one transaction that locks
 * its rows (FOR UPDATE), so a value the API changes meanwhile is either
 * re-sealed before the change or read after it. A value already under the
 * current key is left alone, so an interrupted run is simply run again: it
 * picks up what is left. Each value is re-sealed with the AAD it opened
 * with, so its service reads it exactly as before. Nothing here returns or
 * logs a value.
 */
import { sql, type SQL } from "drizzle-orm";
import {
  ENCRYPTED_COLUMNS,
  readSealedRows,
  type EncryptedColumn,
  type SealedDb,
  type SealedRow,
} from "./encrypted-columns.js";
import { decryptWithKey, encryptWithKey } from "./secret-service.js";

export interface RotationKeys {
  /** The key values are sealed with from now on. */
  current: Buffer;
  /** The key being retired; null for a check of the current key alone. */
  previous: Buffer | null;
}

export interface ColumnCount {
  label: string;
  /** Values that open with the current key (and were left as they were). */
  current: number;
  /** Values re-sealed from the previous key (a dry run: that would be). */
  rotated: number;
  /** Values that open only with the previous key, left so (a check, or a dry run). */
  previous: number;
  /** Values neither key opens: damaged, or sealed under yet another key. */
  unreadable: number;
  /** Up to MAX_NAMED of those, by what they are (never the value). */
  unreadableNamed: string[];
}

export interface RotationReport {
  columns: ColumnCount[];
  current: number;
  rotated: number;
  previous: number;
  unreadable: number;
}

export const DEFAULT_BATCH_SIZE = 200;
const MAX_NAMED = 10;

type Opened =
  | { state: "current" }
  | { state: "previous"; plaintext: string; aad: Buffer }
  | { state: "unreadable" };

function tryOpen(
  key: Buffer,
  sealed: SealedRow,
  aads: Buffer[],
): { plaintext: string; aad: Buffer } | null {
  if (!sealed.blob) return null;
  for (const aad of aads) {
    try {
      return { plaintext: decryptWithKey(key, sealed.blob, aad), aad };
    } catch {
      // the next binding, or not this key
    }
  }
  return null;
}

/** Which key opens a value: the current one, else the previous one (with its plaintext), else neither. */
function classify(column: EncryptedColumn, sealed: SealedRow, keys: RotationKeys): Opened {
  const aads = column.aads(sealed.row);
  if (tryOpen(keys.current, sealed, aads)) return { state: "current" };
  if (keys.previous) {
    const opened = tryOpen(keys.previous, sealed, aads);
    if (opened) return { state: "previous", ...opened };
  }
  return { state: "unreadable" };
}

/** Write a value re-sealed under the current key over its row's blob columns. */
async function reseal(
  tx: SealedDb,
  column: EncryptedColumn,
  sealed: SealedRow,
  opened: { plaintext: string; aad: Buffer },
  key: Buffer,
): Promise<void> {
  const refs = column.columns();
  // A legacy value (16-byte IV) was sealed without an AAD and opens under
  // any: it is re-sealed with the AAD its service reads it with now.
  const legacy = sealed.blob!.iv.length === 16;
  const aad = legacy ? (column.legacyAad?.(sealed.row) ?? column.aads(sealed.row)[0]!) : opened.aad;
  const blob = encryptWithKey(key, opened.plaintext, aad);
  const sets: SQL[] = [
    sql`${sql.identifier(refs.ciphertext.name)} = ${blob.ciphertext}`,
    sql`${sql.identifier(refs.iv.name)} = ${blob.iv}`,
    sql`${sql.identifier(refs.authTag.name)} = ${blob.authTag}`,
  ];
  if (refs.alg) sets.push(sql`${sql.identifier(refs.alg.name)} = ${blob.alg}`);
  await tx.execute(
    sql`UPDATE ${refs.table} SET ${sql.join(sets, sql`, `)} WHERE ${refs.id} = ${sealed.row.id}`,
  );
}

function emptyCount(label: string): ColumnCount {
  return { label, current: 0, rotated: 0, previous: 0, unreadable: 0, unreadableNamed: [] };
}

function total(columns: ColumnCount[]): RotationReport {
  const sum = (k: "current" | "rotated" | "previous" | "unreadable") =>
    columns.reduce((n, c) => n + c[k], 0);
  return {
    columns,
    current: sum("current"),
    rotated: sum("rotated"),
    previous: sum("previous"),
    unreadable: sum("unreadable"),
  };
}

export interface RotationOptions {
  /** Values per batch (one transaction each). */
  batchSize?: number;
  /** Count what a rotation would do; write nothing. */
  dryRun?: boolean;
  /** The columns to walk (default: all of ENCRYPTED_COLUMNS). */
  columns?: readonly EncryptedColumn[];
  /** After each batch: the column's counts so far. */
  onBatch?: (count: ColumnCount) => void;
}

/** One column, batch by batch: re-seal (or, `write` false, only count) what the previous key opens. */
async function walkColumn(
  db: SealedDb,
  column: EncryptedColumn,
  keys: RotationKeys,
  write: boolean,
  batchSize: number,
  onBatch?: (count: ColumnCount) => void,
): Promise<ColumnCount> {
  const count = emptyCount(column.label);
  let after: string | null = null;
  for (;;) {
    const batch = async (tx: SealedDb) => {
      const rows = await readSealedRows(tx, column, { limit: batchSize, after, forUpdate: write });
      for (const sealed of rows) {
        const opened = classify(column, sealed, keys);
        if (opened.state === "current") count.current++;
        else if (opened.state === "previous") {
          if (write) {
            await reseal(tx, column, sealed, opened, keys.current);
            count.rotated++;
          } else count.previous++;
        } else {
          count.unreadable++;
          if (count.unreadableNamed.length < MAX_NAMED)
            count.unreadableNamed.push(column.what(sealed.row));
        }
      }
      return rows;
    };
    const rows = write ? await db.transaction((tx) => batch(tx)) : await batch(db);
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.row.id;
    onBatch?.(count);
    if (rows.length < batchSize) break;
  }
  return count;
}

/**
 * Re-seal every value the previous key opens with the current key. With
 * `dryRun`, only count: `rotated` is then what a run would re-seal. Values
 * already under the current key are left alone, so a run can be repeated.
 */
export async function rotateEncryptionKey(
  db: SealedDb,
  keys: RotationKeys & { previous: Buffer },
  options: RotationOptions = {},
): Promise<RotationReport> {
  if (keys.previous.equals(keys.current)) {
    throw new Error("The previous key is the current key: there is nothing to rotate");
  }
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const columns: ColumnCount[] = [];
  for (const column of options.columns ?? ENCRYPTED_COLUMNS) {
    const count = await walkColumn(db, column, keys, !options.dryRun, batchSize, options.onBatch);
    if (options.dryRun) {
      count.rotated = count.previous;
      count.previous = 0;
    }
    columns.push(count);
  }
  return total(columns);
}

/**
 * Check every value, writing nothing: how many open with the current key,
 * how many only with the previous one (left over), how many with neither.
 * A rotation is finished when `previous` is 0.
 */
export async function verifyEncryptionKey(
  db: SealedDb,
  keys: RotationKeys,
  options: Pick<RotationOptions, "batchSize" | "columns"> = {},
): Promise<RotationReport> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const columns: ColumnCount[] = [];
  for (const column of options.columns ?? ENCRYPTED_COLUMNS) {
    columns.push(await walkColumn(db, column, keys, false, batchSize));
  }
  return total(columns);
}
