/**
 * Shared per-test-file infrastructure for the integration and e2e tiers.
 * Awaited at module scope from a vitest setup file — setup modules finish
 * evaluating BEFORE the test file's own imports are collected, so modules
 * reading configuration at import time (db/client.ts DATABASE_URL,
 * redis-config.ts REDIS_URL) bind to this file's private infrastructure.
 *
 * Isolation model (safe for CONCURRENT vitest runs on one machine):
 *   - Postgres: each test file gets its own database cloned from the
 *     migrated template (built by integration/global-setup.ts), dropped when
 *     the file finishes. Names encode the worker pid so globalSetup only
 *     sweeps databases whose owner process is dead.
 *   - Redis: each test file leases a logical Redis DB index from a Postgres
 *     sequence in the admin database (round-robin over the server's
 *     `databases` count — 4096 via scripts/test-infra.sh), flushed on lease.
 */
import { afterAll } from "vitest";
import { provisionRunInfra, type RunInfra } from "./provision.js";

export type PerFileInfra = Pick<RunInfra, "dbName" | "testDatabaseUrl" | "testRedisUrl">;

export async function initPerFileInfra(runDbPrefix: string): Promise<PerFileInfra> {
  const infra = await provisionRunInfra(runDbPrefix);

  // Point every module that reads config at import time to this file's infra.
  process.env.DATABASE_URL = infra.testDatabaseUrl;
  process.env.REDIS_URL = infra.testRedisUrl;
  process.env.OPTIO_ENCRYPTION_KEY ??=
    "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a7988";
  // Never let tests talk to a real cluster or git platform by accident.
  delete process.env.GITHUB_TOKEN;

  afterAll(async () => {
    await infra.drop();
  }, 30_000);

  return infra;
}
