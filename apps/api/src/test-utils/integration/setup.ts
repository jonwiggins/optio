/**
 * Per-file setup for the integration tier (vitest.integration.config.ts).
 * See ../per-file-infra.ts for the isolation model. Test files import
 * { testDatabaseUrl, testRedisUrl } from here when they need the raw URLs.
 */
import { initPerFileInfra } from "../per-file-infra.js";

export const RUN_DB_PREFIX = "optio_it_run_";

const infra = await initPerFileInfra(RUN_DB_PREFIX);

export const testDatabaseUrl = infra.testDatabaseUrl;
export const testRedisUrl = infra.testRedisUrl;
