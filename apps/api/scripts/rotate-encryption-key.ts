/**
 * Rotate the encryption key: re-seal every value in the database that is
 * still under the previous key with the current one. Run it in the API pod
 * once the API runs with the new key as OPTIO_ENCRYPTION_KEY and the old one
 * as OPTIO_ENCRYPTION_KEY_PREVIOUS (docs/cryptography.md, "Rotating the
 * encryption key"):
 *
 *   tsx scripts/rotate-encryption-key.ts --dry-run
 *       count what a rotation would re-seal; write nothing
 *   tsx scripts/rotate-encryption-key.ts [--batch-size <n>]
 *       re-seal, batch by batch (one transaction each), then check that no
 *       value is left under the previous key, and record the rotation in the
 *       action log (secrets.key_rotated)
 *   tsx scripts/rotate-encryption-key.ts --verify
 *       only the check (OPTIO_ENCRYPTION_KEY_PREVIOUS optional)
 *
 * A run that stops part way is run again: values already under the new key
 * are left alone. Prints counts per kind of value and names the values
 * neither key opens (never a value). Exit status: 0 every value opens with
 * the current key; 1 values are still under the previous key; 2 the run
 * couldn't start or stopped (usage, keys, the database); 3 none is left
 * under the previous key, but some values open with neither key (re-enter
 * those).
 */
import {
  DEFAULT_BATCH_SIZE,
  rotateEncryptionKey,
  verifyEncryptionKey,
  type RotationReport,
} from "../src/services/encryption-key-rotation.js";
import { connectTo, databaseOf, errorText } from "../src/services/database-restore-check.js";
import { logAction } from "../src/services/optio-action-service.js";
import { parseEncryptionKey } from "../src/services/secret-service.js";

function usage(message: string): never {
  console.error(
    `${message}\nUsage: tsx scripts/rotate-encryption-key.ts [--dry-run | --verify] [--batch-size <n>]`,
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let dryRun = false;
let verifyOnly = false;
let batchSize = DEFAULT_BATCH_SIZE;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--dry-run") dryRun = true;
  else if (a === "--verify") verifyOnly = true;
  else if (a === "--batch-size") {
    const n = Number(args[++i]);
    if (!Number.isInteger(n) || n < 1 || n > 10_000) usage("--batch-size takes 1 to 10000");
    batchSize = n;
  } else usage(`Unknown argument: ${a}`);
}
if (dryRun && verifyOnly) usage("--dry-run and --verify don't go together");
const live = process.env.DATABASE_URL;
if (!live) usage("DATABASE_URL is not set");

let current: Buffer;
let previous: Buffer | null = null;
try {
  const currentValue = process.env.OPTIO_ENCRYPTION_KEY;
  if (!currentValue) usage("OPTIO_ENCRYPTION_KEY (the new key) is not set");
  current = parseEncryptionKey(currentValue);
  const previousValue = process.env.OPTIO_ENCRYPTION_KEY_PREVIOUS;
  if (previousValue) previous = parseEncryptionKey(previousValue, "OPTIO_ENCRYPTION_KEY_PREVIOUS");
} catch (err) {
  usage(err instanceof Error ? err.message : String(err));
}
if (!verifyOnly && !previous) {
  usage("OPTIO_ENCRYPTION_KEY_PREVIOUS (the old key) is not set: there is nothing to rotate from");
}
if (previous?.equals(current)) {
  usage("OPTIO_ENCRYPTION_KEY_PREVIOUS is the same key as OPTIO_ENCRYPTION_KEY");
}

const where = databaseOf(live);
function print(report: RotationReport, what: "rotated" | "would re-seal") {
  for (const c of report.columns) {
    const parts = [`${c.current} under the new key`];
    if (c.rotated) parts.push(`${c.rotated} ${what}`);
    if (c.previous) parts.push(`${c.previous} still under the old key`);
    if (c.unreadable) parts.push(`${c.unreadable} open with neither key`);
    console.log(`  ${c.label}: ${parts.join(", ")}`);
    if (c.unreadableNamed.length)
      console.log(`    neither key opens: ${c.unreadableNamed.join(", ")}`);
  }
}

let code = 0;
const { db, close } = connectTo(live);
try {
  if (dryRun) {
    const r = await rotateEncryptionKey(
      db,
      { current, previous: previous! },
      { dryRun: true, batchSize },
    );
    console.log(`dry run in ${where}: ${r.rotated} values would be re-sealed under the new key`);
    print(r, "would re-seal");
  } else {
    if (!verifyOnly) {
      const r = await rotateEncryptionKey(
        db,
        { current, previous: previous! },
        {
          batchSize,
          onBatch: (c) =>
            console.log(`  … ${c.label}: ${c.rotated} re-sealed, ${c.current} already new`),
        },
      );
      console.log(`rotation in ${where}: re-sealed ${r.rotated} values under the new key`);
      print(r, "rotated");
      try {
        await logAction({
          action: "secrets.key_rotated",
          workspaceId: null,
          result: { rotated: r.rotated, alreadyCurrent: r.current, unreadable: r.unreadable },
          success: true,
        });
      } catch (err) {
        console.error(`Couldn't record the rotation in the action log: ${errorText(err)}`);
      }
    }
    const v = await verifyEncryptionKey(db, { current, previous }, { batchSize });
    console.log(
      `check in ${where}: ${v.current} values open with the new key, ${v.previous} still under the old key, ${v.unreadable} with neither`,
    );
    print(v, "rotated");
    if (v.previous > 0) {
      console.log("  Values are still under the old key: run the rotation again.");
      code = 1;
    } else if (v.unreadable > 0) {
      console.log(
        "  None is left under the old key. The values neither key opens were damaged or sealed under another key: re-enter those.",
      );
      code = 3;
    } else {
      console.log(
        "  Every value opens with the new key: OPTIO_ENCRYPTION_KEY_PREVIOUS can be removed.",
      );
    }
  }
} catch (err) {
  console.error(`The rotation stopped: ${errorText(err)}. Run it again to continue.`);
  code = 2;
} finally {
  await close().catch(() => undefined);
}
process.exit(code);
