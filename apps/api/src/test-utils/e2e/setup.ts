/**
 * Per-file setup for the e2e tier (vitest.e2e.config.ts). Provisions a
 * private database + Redis logical DB for this file (see ../per-file-infra.ts)
 * — the spawned API server (./api-server.ts) inherits them via process.env.
 */
import { initPerFileInfra } from "../per-file-infra.js";

export const E2E_RUN_DB_PREFIX = "optio_e2e_run_";

const infra = await initPerFileInfra(E2E_RUN_DB_PREFIX);

export const testDatabaseUrl = infra.testDatabaseUrl;
export const testRedisUrl = infra.testRedisUrl;
