import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { ErrorResponseSchema } from "../schemas/common.js";
import { getUserRole } from "../services/workspace-service.js";

const UserLookupResponseSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
  }),
});

export async function userRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/users/lookup",
    {
      schema: {
        operationId: "lookupUserByEmail",
        summary: "Lookup user by email",
        description: "Find a user by their email address. Restricted to workspace admins.",
        tags: ["Users"],
        querystring: z.object({
          email: z.string().email(),
        }),
        response: {
          200: UserLookupResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) {
        return reply.status(401).send({ error: "Authentication required" });
      }

      const workspaceId = req.user.workspaceId;
      if (!workspaceId) {
        return reply.status(400).send({ error: "No workspace context" });
      }

      // Check if current user is admin in this workspace
      const role = await getUserRole(workspaceId, req.user.id);
      if (role !== "admin") {
        return reply.status(403).send({ error: "Only admins can look up users by email" });
      }

      const { email } = req.query;
      const [user] = await db
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
        })
        .from(users)
        .where(eq(users.email, email));

      if (!user) {
        return reply.status(404).send({ error: "User not found" });
      }

      return { user };
    },
  );
}
