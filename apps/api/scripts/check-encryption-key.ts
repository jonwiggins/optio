/**
 * Does this deployment's encryption key (OPTIO_ENCRYPTION_KEY) open the
 * values sealed in its database? scripts/backup/restore-db.sh runs it in the
 * API pod after a restore or a restore drill (docs/backup.md):
 *
 *   tsx scripts/check-encryption-key.ts
 *       the live database (DATABASE_URL)
 *   tsx scripts/check-encryption-key.ts --record-restore <dump> [--kept-as <db>]
 *       first the restore in the action log (database.restored), then the same
 *   tsx scripts/check-encryption-key.ts --database <name> [--drop-after]
 *       a drill's database on the same server; --drop-after drops it after
 *       the check — only a database a drill made (never the live one, a
 *       restore's kept one, or anyone else's)
 *
 * Prints how many sealed values the key opens — the stored tokens and the
 * secrets on model providers, connections, webhooks, repos and sign-in — and
 * names the ones it doesn't (never a value). Exit status:
 * 0 it opens them, or nothing is sealed; 1 it opens none (the dump and the
 * key don't belong together; the line "It opens none" says so); 2 the check
 * couldn't run (usage, or the database can't be read), or the drill's
 * database couldn't be dropped.
 */
import {
  checkEncryptionKeyAt,
  databaseOf,
  databaseUrlFor,
  dropDrillDatabase,
  errorText,
  notADrillDatabase,
  recordRestore,
} from "../src/services/database-restore-check.js";

function usage(message: string): never {
  console.error(
    `${message}\nUsage: tsx scripts/check-encryption-key.ts [--database <name> [--drop-after]] [--record-restore <dump> [--kept-as <db>]]`,
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let database: string | null = null;
let dropAfter = false;
let restoredFrom: string | null = null;
let keptAs: string | null = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const value = () => args[++i] ?? usage(`${a} needs a value`);
  if (a === "--database") database = value();
  else if (a === "--drop-after") dropAfter = true;
  else if (a === "--record-restore") restoredFrom = value();
  else if (a === "--kept-as") keptAs = value();
  else usage(`Unknown argument: ${a}`);
}
const live = process.env.DATABASE_URL;
if (!live) usage("DATABASE_URL is not set");
if (dropAfter && !database) usage("--drop-after goes with --database");
if (restoredFrom && database) usage("--record-restore is for the live database (no --database)");

let target = live;
try {
  if (database) {
    if (database === databaseOf(live))
      usage(`${database} is the live database; leave --database out`);
    // A database that may never be dropped as a drill's isn't read as one either.
    const refusal = dropAfter ? notADrillDatabase(live, database) : null;
    if (refusal) usage(refusal);
    target = databaseUrlFor(live, database);
  }
} catch (err) {
  usage(err instanceof Error ? err.message : String(err));
}
const where = database ?? databaseOf(live);

let code = 0;
// The restore happened whatever the key check finds, and whether it can run
// at all: the log names it first.
if (restoredFrom) {
  try {
    await recordRestore({ dump: restoredFrom, keptAs });
    console.log(`action log: database restored from ${restoredFrom}`);
  } catch (err) {
    console.error(`Couldn't record the restore in the action log: ${errorText(err)}`);
    code = 2;
  }
}
try {
  const r = await checkEncryptionKeyAt(target);
  if (r.verdict === "empty") {
    console.log(`encryption key: ${where} stores no secrets, so there is nothing to check`);
  } else {
    console.log(`encryption key: opens ${r.opened} of ${r.checked} stored secrets in ${where}`);
    console.log(`  ${r.sources.map((s) => `${s.source} ${s.opened}/${s.checked}`).join(", ")}`);
    if (r.failed.length > 0) console.log(`  not opened: ${r.failed.join(", ")}`);
    if (r.verdict === "wrong-key") {
      console.log(
        "  It opens none: this deployment's OPTIO_ENCRYPTION_KEY is not the key these secrets were stored with.",
      );
      code = 1;
    } else if (r.opened < r.checked) {
      console.log("  The rest were stored under another binding or are damaged; re-enter those.");
    }
  }
} catch (err) {
  console.error(`The key check couldn't read ${where}: ${errorText(err)}`);
  code = 2;
}
if (dropAfter && database) {
  try {
    if (await dropDrillDatabase(live, database)) {
      console.log(`dropped the drill's database ${database}`);
    } else {
      console.log(`no database ${database} to drop`);
    }
  } catch (err) {
    console.error(`Couldn't drop ${database}: ${errorText(err)}`);
    if (code === 0) code = 2;
  }
}
process.exit(code);
