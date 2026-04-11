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

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** UUID path parameter used by every `/:id` route. */
export const IdParamsSchema = z
  .object({
    id: z.string().describe("Resource identifier (UUID)"),
  })
  .describe("Path parameters: resource id");

/** ISO-8601 timestamp string (as produced by Drizzle `timestamp` columns). */
export const TimestampString = z.string().describe("ISO-8601 timestamp");

/**
 * Offset/limit pagination envelope factory. Produces a fresh `z.object`
 * with the provided key for the items array, plus `limit` and `offset`.
 */
export function offsetPaginationEnvelope<T extends z.ZodTypeAny>(itemsKey: string, itemSchema: T) {
  return z.object({
    [itemsKey]: z.array(itemSchema).describe("Page of results"),
    limit: z.number().int().describe("Page size"),
    offset: z.number().int().describe("Offset from start"),
  });
}

/** Cursor-based pagination envelope factory. */
export function cursorPaginationEnvelope<T extends z.ZodTypeAny>(itemsKey: string, itemSchema: T) {
  return z.object({
    [itemsKey]: z.array(itemSchema).describe("Page of results"),
    nextCursor: z.string().nullable().describe("Next page cursor, or null at end"),
    hasMore: z.boolean().describe("Whether another page is available"),
  });
}

/** Empty 204 response body. */
export const EmptyResponseSchema = z.object({}).describe("Empty response");
