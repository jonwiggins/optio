/**
 * Builds the Fastify app, calls `app.swagger()` to get the finished spec,
 * writes it to `apps/api/openapi.generated.json`, and exits.
 *
 * Called from `pnpm --filter @optio/api run openapi:dump`. The output is
 * `.gitignore`'d — it's a build artifact, not a source of truth.
 *
 * Used by:
 * - The `openapi:lint` script (redocly CLI)
 * - The `openapi-lint` CI job
 * - Local verification after route migrations (`cat apps/api/openapi.generated.json | jq`)
 *
 * Intentionally avoids `@optio/api`'s real startup path (no telemetry, no
 * DB, no Redis, no workers). Environment variables that unlock mock behavior:
 * - OPTIO_SKIP_DB_HEALTH=1 skips the DB ping during buildServer (not
 *   currently honored; buildServer is a pure route registration.) The health
 *   route executes only at request time, so we're fine with no DB.
 */
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// BullMQ queues and service-level Redis clients are constructed at import
// time. When dumping the OpenAPI spec we don't care about Redis at all —
// swallow the expected ECONNREFUSED so CI logs stay clean. Any other
// unhandled rejection still surfaces.
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (message.includes("ECONNREFUSED") && message.includes("6379")) return;
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});
// ioredis emits connection errors as "error" events on the client instance.
// They bubble up as "Unhandled error event" logs via pino. Silence stderr
// chatter from that path by intercepting process.stderr writes that match.
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
  const text = typeof chunk === "string" ? chunk : chunk.toString();
  if (
    text.includes("ECONNREFUSED") ||
    text.includes("Unhandled error event") ||
    text.includes("ioredis")
  ) {
    return true;
  }

  return origStderrWrite(chunk, ...(args as any));
}) as any;

// Lazily import so that `dotenv/config` has already run before any module
// that reads env vars at import time (e.g. redis-config).
async function main() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  // Avoid the real encryption key check — dump-openapi only needs the spec,
  // not the ability to decrypt secrets.
  process.env.OPTIO_ENCRYPTION_KEY = process.env.OPTIO_ENCRYPTION_KEY ?? "0".repeat(64);
  // Skip Redis-backed rate limit init; dump doesn't serve traffic.
  process.env.OPTIO_SKIP_RATE_LIMIT_REDIS = "1";

  const { buildServer } = await import("../src/server.js");
  const app = await buildServer();
  await app.ready();

  // `@fastify/swagger` exposes the current spec via `app.swagger()`.
  const swagger = (app as unknown as { swagger: () => unknown }).swagger;
  if (typeof swagger !== "function") {
    throw new Error("app.swagger() is not a function — is @fastify/swagger registered?");
  }
  const spec = (app as unknown as { swagger: () => unknown }).swagger();

  const outPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "openapi.generated.json");
  await writeFile(outPath, JSON.stringify(spec, null, 2) + "\n", "utf8");
  console.log(`Wrote ${outPath}`);

  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
