/**
 * Vitest-free core of the per-run infrastructure provisioning: clone a
 * private database from the migrated template and lease a Redis logical DB.
 * Used by per-file-infra.ts (vitest tiers) and by the Playwright stack
 * launcher (apps/web/e2e/launch-stack.ts), which cannot register vitest
 * hooks. Callers own calling drop() when done; abandoned databases are
 * swept by the next globalSetup run once the creating pid dies.
 *
 * ASSUMPTION: the database server is private to this host (local docker
 * containers or a CI-job service). The sweeper checks pid liveness locally,
 * so sharing one test database server across machines would let one host
 * sweep another's live run databases.
 */
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { TEMPLATE_DB } from "./integration/global-setup.js";

export interface RunInfra {
  dbName: string;
  testDatabaseUrl: string;
  testRedisUrl: string;
  drop(): Promise<void>;
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function provisionRunInfra(runDbPrefix: string): Promise<RunInfra> {
  const adminUrl = process.env.OPTIO_TEST_PG_URL;
  const redisBase = process.env.OPTIO_TEST_REDIS_URL;
  if (!adminUrl || !redisBase) {
    throw new Error(
      "provisionRunInfra needs OPTIO_TEST_PG_URL / OPTIO_TEST_REDIS_URL — " +
        "run the integration globalSetup (or scripts/test-infra.sh start) first.",
    );
  }

  const dbName = `${runDbPrefix}${process.pid}_${randomBytes(4).toString("hex")}`;
  const testDatabaseUrl = withDatabase(adminUrl, dbName);

  const admin = postgres(adminUrl, { max: 1 });
  let testRedisUrl: string;
  try {
    // Clone this run's private database from the migrated template.
    // WAL_LOG strategy (PG15+ default) allows concurrent clones of the same
    // template; retry in case another worker holds the template lock.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await admin.unsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${TEMPLATE_DB}"`);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    if (lastErr) throw lastErr;

    // Lease a collision-free Redis logical DB index from the round-robin
    // sequence in the admin database (created by globalSetup).
    const { Redis } = await import("ioredis");
    const probe = new Redis(redisBase, { lazyConnect: true });
    await probe.connect();
    const configReply = (await probe.config("GET", "databases")) as [string, string];
    const dbCount = Number(configReply[1] ?? 16);
    const [seqRow] = await admin`SELECT nextval('optio_test_redis_db_seq') AS n`;
    const redisDb = Number(seqRow.n) % dbCount;
    await probe.select(redisDb);
    await probe.flushdb();
    await probe.quit();
    testRedisUrl = `${redisBase.replace(/\/+$/, "")}/${redisDb}`;
  } finally {
    await admin.end({ timeout: 5 });
  }

  return {
    dbName,
    testDatabaseUrl,
    testRedisUrl,
    async drop() {
      const cleanup = postgres(adminUrl, { max: 1 });
      try {
        // FORCE terminates connections still held by the app pool or a
        // lingering spawned server.
        await cleanup.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } catch {
        // Leftovers get swept by the next run's globalSetup.
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    },
  };
}
