import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorResponseSchema } from "../schemas/common.js";
import { isAuthDisabled } from "../services/oauth/index.js";
import { logAction } from "../services/optio-action-service.js";
import {
  SignInConfigError,
  addDeploymentAdminByEmail,
  deleteSignInConfig,
  hasDeploymentAdmin,
  isBootstrapMode,
  isDeploymentAdmin,
  listDeploymentAdmins,
  listSignInProviders,
  recordBootstrapClaim,
  removeDeploymentAdmin,
  saveSignInConfig,
  setupTokenUsable,
  verifySetupToken,
} from "../services/sign-in-config-service.js";
import { normalizeAutoJoinDomains } from "../services/workspace-service.js";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";

/**
 * How everyone signs in — `GET/PUT/DELETE /api/auth/sign-in[/:provider]` and
 * the deployment admins who may change it. See
 * services/sign-in-config-service.ts for the rules.
 *
 * Who may call what:
 * - A **deployment admin** (signed in): everything.
 * - The **setup token** (`X-Optio-Setup-Token`) while it is usable — nobody
 *   can sign in yet (bootstrap; the request has no session, the auth plugin
 *   lets `/api/auth/sign-in*` through then), or the deployment has no
 *   deployment admin yet (a signed-in person claims the role): save the first
 *   provider, claim the role.
 * - Anyone signed in: `GET` (what's configured, never a secret), so the
 *   Settings card can show status; `canEdit` says whether they may change it.
 */

const SETUP_TOKEN_HEADER = "x-optio-setup-token";

const saveSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  allowedDomains: z.array(z.string()).max(20).optional(),
  enabled: z.boolean().optional(),
  displayName: z.string().max(60).nullable().optional(),
  /**
   * Bootstrap only: the organization's name. The first person to sign in
   * becomes the deployment admin and their workspace takes this name, with
   * the allowed domains auto-joining it.
   */
  organizationName: z.string().min(1).max(100).optional(),
});

const providerParams = z.object({ provider: z.string() });

async function tokenGrantsAccess(req: FastifyRequest): Promise<boolean> {
  const token = req.headers[SETUP_TOKEN_HEADER];
  if (typeof token !== "string" || !token) return false;
  return (await setupTokenUsable()) && (await verifySetupToken(token));
}

/** Deployment admins, or the setup token while it is usable. */
async function requireDeploymentAdminOrToken(req: FastifyRequest, reply: FastifyReply) {
  if (isAuthDisabled()) return;
  if (req.user && (await isDeploymentAdmin(req.user))) return;
  if (await tokenGrantsAccess(req)) return;
  const bootstrap = await isBootstrapMode();
  return reply.status(403).send({
    error: bootstrap
      ? "The setup token is required (see the API log, or OPTIO_SETUP_TOKEN)"
      : "Only a deployment admin can change how people sign in",
  });
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof SignInConfigError)
    return reply.status(err.status).send({ error: err.message });
  throw err;
}

export async function signInRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/auth/sign-in",
    {
      schema: {
        operationId: "getSignInConfig",
        summary: "How people sign in",
        description:
          "Every OAuth provider — stored in the app or from the environment — with its " +
          "redirect URI and allowed domains (never a secret), whether the deployment is in " +
          "bootstrap mode (nobody can sign in yet), whether the caller may change it, and the " +
          "deployment admins (deployment admins only). Public while in bootstrap mode.",
        tags: ["Auth & Sessions"],
        response: { 200: z.unknown() },
      },
    },
    async (req, reply) => {
      const bootstrap = await isBootstrapMode();
      const admin = isAuthDisabled() || (!!req.user && (await isDeploymentAdmin(req.user)));
      const tokenOk = !admin && (await tokenGrantsAccess(req));
      const canEdit = admin || tokenOk;
      // A signed-in person with no deployment admin anywhere can claim the role with the token.
      const canClaim = !!req.user && !admin && !(await hasDeploymentAdmin());
      reply.send({
        bootstrap,
        canEdit,
        canClaim,
        publicUrl: process.env.PUBLIC_URL ?? null,
        providers: await listSignInProviders(),
        deploymentAdmins: admin ? await listDeploymentAdmins() : undefined,
      });
    },
  );

  app.put(
    "/api/auth/sign-in/:provider",
    {
      preHandler: [requireDeploymentAdminOrToken],
      schema: {
        operationId: "saveSignInProvider",
        summary: "Configure a sign-in provider",
        description:
          "Store a provider's OAuth client (today: `google`), its allowed domains and whether " +
          "it is enabled. The client secret is encrypted at rest and never returned. Needs a " +
          "deployment admin, or the setup token while nobody can sign in yet.",
        tags: ["Auth & Sessions"],
        params: providerParams,
        body: saveSchema,
        response: { 200: z.unknown(), 400: ErrorResponseSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { provider } = req.params;
      const { organizationName, ...input } = req.body;
      try {
        const view = await saveSignInConfig(provider, input, req.user?.id ?? null);
        // Bootstrapping: remember what the first sign-in should complete.
        if (!(await hasDeploymentAdmin())) {
          const domains = input.allowedDomains
            ? normalizeAutoJoinDomains(input.allowedDomains)
            : { domains: [] as string[] };
          await recordBootstrapClaim({
            provider,
            organizationName: organizationName?.trim() || null,
            domains: "domains" in domains ? domains.domains : [],
          });
        }
        logAction({
          userId: req.user?.id,
          action: "sign_in.provider_saved",
          params: { provider, allowedDomains: input.allowedDomains, enabled: input.enabled },
          result: { provider },
          success: true,
        }).catch(() => {});
        reply.send({ provider: view, bootstrap: await isBootstrapMode() });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete(
    "/api/auth/sign-in/:provider",
    {
      preHandler: [requireDeploymentAdminOrToken],
      schema: {
        operationId: "deleteSignInProvider",
        summary:
          "Forget a provider's stored config (its environment config, if any, applies again)",
        tags: ["Auth & Sessions"],
        params: providerParams,
        response: { 204: z.null(), 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      await deleteSignInConfig(req.params.provider);
      logAction({
        userId: req.user?.id,
        action: "sign_in.provider_deleted",
        params: { provider: req.params.provider },
        result: { provider: req.params.provider },
        success: true,
      }).catch(() => {});
      reply.status(204).send(null);
    },
  );

  // ── Deployment admins ─────────────────────────────────────────────────────

  app.get(
    "/api/auth/deployment-admins",
    {
      preHandler: [requireDeploymentAdminOrToken],
      schema: {
        operationId: "listDeploymentAdmins",
        summary: "The people who may change how everyone signs in",
        tags: ["Auth & Sessions"],
        response: { 200: z.object({ admins: z.array(z.unknown()) }), 403: ErrorResponseSchema },
      },
    },
    async (_req, reply) => {
      reply.send({ admins: await listDeploymentAdmins() });
    },
  );

  app.post(
    "/api/auth/deployment-admins",
    {
      preHandler: [requireDeploymentAdminOrToken],
      schema: {
        operationId: "addDeploymentAdmin",
        summary: "Make an existing user a deployment admin, by email",
        tags: ["Auth & Sessions"],
        body: z.object({ email: z.string().email() }),
        response: { 201: z.unknown(), 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        const admin = await addDeploymentAdminByEmail(req.body.email);
        logAction({
          userId: req.user?.id,
          action: "sign_in.deployment_admin_added",
          params: { email: req.body.email },
          result: { id: admin.id },
          success: true,
        }).catch(() => {});
        reply.status(201).send({ admin });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete(
    "/api/auth/deployment-admins/:id",
    {
      preHandler: [requireDeploymentAdminOrToken],
      schema: {
        operationId: "removeDeploymentAdmin",
        summary: "Take the deployment-admin role from someone (never the last one)",
        tags: ["Auth & Sessions"],
        params: z.object({ id: z.string().uuid() }),
        response: {
          204: z.null(),
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        await removeDeploymentAdmin(req.params.id, req.user?.id ?? null);
        reply.status(204).send(null);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /**
   * A signed-in person claims the role with the setup token — only while the
   * deployment has no deployment admin at all (an upgrade from before the
   * role existed). The token is useless once someone holds the role.
   */
  app.post(
    "/api/auth/deployment-admins/claim",
    {
      schema: {
        operationId: "claimDeploymentAdmin",
        summary: "Become the first deployment admin with the setup token",
        tags: ["Auth & Sessions"],
        response: { 200: z.unknown(), 401: ErrorResponseSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (isAuthDisabled()) return reply.send({ ok: true });
      if (!req.user) return reply.status(401).send({ error: "Sign in first" });
      if (await hasDeploymentAdmin()) {
        return reply.status(403).send({ error: "This deployment already has a deployment admin" });
      }
      const token = req.headers[SETUP_TOKEN_HEADER];
      if (typeof token !== "string" || !(await verifySetupToken(token))) {
        return reply.status(403).send({ error: "That isn't the setup token (see the API log)" });
      }
      await db.update(users).set({ deploymentAdmin: true }).where(eq(users.id, req.user.id));
      logAction({
        userId: req.user.id,
        action: "sign_in.deployment_admin_claimed",
        params: {},
        result: { id: req.user.id },
        success: true,
      }).catch(() => {});
      reply.send({ ok: true });
    },
  );
}
