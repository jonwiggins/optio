import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { currentFeatures, featureEnvWarnings } from "@optio/shared";
import { logger } from "../logger.js";

/**
 * What this deployment offers (packages/shared/src/config/features.ts,
 * docs/feature-lists.md): the agent runtimes, git platforms, trigger types,
 * ticket sources and connection providers. With nothing set every list holds
 * everything Optio knows. Anyone signed in reads it; the web hides what a
 * list leaves out.
 */
export const DeploymentFeaturesSchema = z
  .object({
    runtimes: z.array(z.string()).describe("Agent runtimes offered (OPTIO_RUNTIMES)"),
    gitPlatforms: z.array(z.string()).describe("Git platforms offered (OPTIO_GIT_PLATFORMS)"),
    triggers: z.array(z.string()).describe("Trigger types offered (OPTIO_TRIGGERS)"),
    ticketSources: z.array(z.string()).describe("Ticket sources offered (OPTIO_TICKET_SOURCES)"),
    connectionProviders: z
      .array(z.string())
      .describe("Built-in connection providers offered (OPTIO_CONNECTION_PROVIDERS)"),
  })
  .describe("DeploymentFeatures");

export async function featureRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  // Once, as the server starts: what in the feature settings is ignored.
  const ignored = featureEnvWarnings();
  if (ignored.length > 0) logger.warn({ ignored }, "Feature settings Optio ignores");

  app.get(
    "/api/features",
    {
      schema: {
        operationId: "getDeploymentFeatures",
        summary: "What this deployment offers",
        description:
          "The agent runtimes, git platforms, trigger types, ticket sources and " +
          "connection providers this deployment offers. Every list holds everything " +
          "unless an admin narrowed it. Requires a session.",
        tags: ["Setup & Settings"],
        response: { 200: DeploymentFeaturesSchema },
      },
    },
    async (_req, reply) => {
      reply.send(currentFeatures());
    },
  );
}
