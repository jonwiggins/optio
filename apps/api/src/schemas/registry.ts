import { ErrorResponseSchema } from "./common.js";

/**
 * Central registry of named schemas surfaced as `components.schemas` in the
 * generated OpenAPI document.
 *
 * `@fastify/swagger` calls `createJsonSchemaTransformObject({ schemas })`
 * once and the resulting transform walks the final spec, replacing any
 * structurally-equal JSON fragment with a `$ref` pointer into
 * `components.schemas`. Names here become the keys of that components map.
 *
 * Add new named schemas as new route phases migrate. Keep names stable —
 * clients generated from the spec use them as TypeScript type identifiers.
 */
export const namedSchemas = {
  ErrorResponse: ErrorResponseSchema,
} as const;
