import { z } from "zod";

/**
 * Shared OpenAPI schemas used across every route.
 *
 * Named schemas in this file (and its siblings in `schemas/`) are registered
 * with `@fastify/swagger` via `createJsonSchemaTransformObject` in
 * `apps/api/src/schemas/registry.ts`. The transform matches on structural
 * equality and replaces matching shapes with `$ref` pointers into
 * `components.schemas`, so every response/request schema that reuses these
 * deduplicates automatically in the generated spec.
 *
 * Keep this file dependency-free — it must not import from `routes/`,
 * `services/`, or `plugins/` to avoid cycles.
 */

/** Standard error envelope returned by every 4xx/5xx response. */
export const ErrorResponseSchema = z
  .object({
    error: z.string().describe("Human-readable error summary"),
    details: z.string().optional().describe("Optional detail string; format varies by error class"),
  })
  .describe("Error response envelope");

/** UUID path parameter used by every `/:id` route. */
export const IdParamsSchema = z
  .object({
    id: z.string().describe("Resource identifier (UUID)"),
  })
  .describe("Path parameters: resource id");

/** Empty 204 response body. */
export const EmptyResponseSchema = z.object({}).describe("Empty response");
