import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorResponseSchema } from "../schemas/common.js";
import { saveSignInSchema, testSignInSchema } from "../schemas/sign-in.js";
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
  markOrganizationWorkspace,
  organizationWorkspaceId,
  recordBootstrapClaim,
  removeDeploymentAdmin,
  saveSignInConfig,
  setupTokenUsable,
  testSignInProvider,
  verifySetupToken,
} from "../services/sign-in-config-service.js";
import { normalizeAutoJoinDomains } from "../services/workspace-service.js";
import { searchSignInGroups } from "../services/sign-in-groups.js";
import { db } from "../db/client.js";
import { users, workspaces } from "../db/schema.js";
import { eq } from "drizzle-orm";

/**
 * How everyone signs in — `GET/PUT/DELETE /api/auth/sign-in[/:provider]`,
 * `POST /api/auth/sign-in/:provider/test`, and the deployment admins who may
 * change it. See services/sign-in-config-service.ts for the rules.
 *
 * Who may call what:
 * - A **deployment admin** (signed in): everything.
 * - The **setup token** (`X-Optio-Setup-Token`) while it is usable — nobody
 *   can sign in yet (bootstrap; the request has no session, the auth plugin
 *   lets `/api/auth/sign-in*` through then), or the deployment has no
 *   deployment admin yet (a signed-in person claims the role): save and test
 *   the first provider, claim the role.
 * - Anyone signed in: `GET` (what's configured, never a secret), so the
 *   Settings card can show status; `canEdit` says whether they may change it.
 */

const SETUP_TOKEN_HEADER = "x-optio-setup-token";

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

/** The workspace people with `autoJoinOrganization` join, if one is marked. */
async function organizationWorkspaceView(): Promise<{ id: string; name: string } | null> {
  const id = await organizationWorkspaceId();
  if (!id) return null;
  const [ws] = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, id));
  return ws ?? null;
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
          "Every sign-in provider (Bitbucket, Gitea / Forgejo, GitHub, GitLab, Google, LDAP, " +
          "OpenID Connect, SAML) — stored in " +
          "the app or from the environment — with its redirect URI, allowed domains and " +
          "settings (never a secret), whether the deployment is in " +
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
        organizationWorkspace: admin ? await organizationWorkspaceView() : undefined,
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
          "Store a provider's settings (`google`, `bitbucket`: the OAuth client; `gitea`: the " +
          "server URL and its OAuth client; `oidc`: client id, secret, issuer and claims; " +
          "`saml`: the identity provider's metadata or SSO URL and certificate, and the " +
          "attributes; `ldap`: the directory and its layout, with the bind password as " +
          "the secret), its allowed domains and whether it is enabled. GitHub and GitLab are " +
          "configured by environment variables. Secrets are encrypted at rest and never " +
          "returned. Needs a deployment admin, or the setup token while nobody can sign in yet.",
        tags: ["Auth & Sessions"],
        params: providerParams,
        body: saveSignInSchema,
        response: {
          200: z.unknown(),
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
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
          clientIp: req.ip, // the audit trail (docs/audit.md).
        }).catch(() => {});
        reply.send({ provider: view, bootstrap: await isBootstrapMode() });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    "/api/auth/sign-in/:provider/test",
    {
      preHandler: [requireDeploymentAdminOrToken],
      schema: {
        operationId: "testSignInProvider",
        summary: "Try a provider's settings before saving them",
        description:
          "`oidc`: fetch the issuer's discovery document (through the given CA) and report its " +
          "endpoints, scopes and claims. `ldap`: connect, bind the service account and look " +
          "up a sample user. The stored secret is used when none is given. Nothing is stored.",
        tags: ["Auth & Sessions"],
        params: providerParams,
        body: testSignInSchema,
        response: { 200: z.unknown(), 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        reply.send(await testSignInProvider(req.params.provider, req.body));
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
        clientIp: req.ip, // the audit trail (docs/audit.md).
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
          clientIp: req.ip, // the audit trail (docs/audit.md).
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
        // the audit trail (docs/audit.md).
        logAction({
          userId: req.user?.id,
          action: "sign_in.deployment_admin_removed",
          params: { targetUserId: req.params.id },
          result: { id: req.params.id },
          success: true,
          clientIp: req.ip,
        }).catch(() => {});
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
        clientIp: req.ip, // the audit trail (docs/audit.md).
      }).catch(() => {});
      reply.send({ ok: true });
    },
  );

  /**
   * "Make this the organization workspace": the workspace people join when
   * a provider's `autoJoinOrganization` is on. Only the setup wizard's
   * bootstrap or this marks one — never a sign-in. Deployment admins only.
   */
  app.put(
    "/api/workspaces/:id/organization",
    {
      preHandler: [requireDeploymentAdminOrToken],
      schema: {
        operationId: "markOrganizationWorkspace",
        summary: "Make a workspace the organization's (the one auto-join lands in)",
        tags: ["Auth & Sessions"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.unknown(), 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [ws] = await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, req.params.id));
      if (!ws) return reply.status(404).send({ error: "No such workspace" });
      await markOrganizationWorkspace(ws.id);
      logAction({
        userId: req.user?.id,
        action: "sign_in.organization_workspace_marked",
        params: { workspaceId: ws.id },
        result: { workspaceId: ws.id },
        success: true,
        clientIp: req.ip,
      }).catch(() => {});
      reply.send({ organizationWorkspace: ws });
    },
  );

  /**
   * The group pickers' search (workspace access groups, team mappings,
   * admin / required groups): the LDAP directory's groups when LDAP is
   * configured, and the groups Optio has seen. Any signed-in person — the
   * names are what the sign-in screens and team pages show anyway.
   */
  app.get(
    "/api/auth/groups",
    {
      schema: {
        operationId: "searchSignInGroups",
        summary: "Search identity-provider groups",
        description:
          "Groups whose name contains `q`: from the LDAP directory (when the LDAP provider " +
          "is configured; bound as its service account, at most `limit`) and the groups " +
          "people signed in with, team mappings and workspaces name. `ldapError` says why " +
          "the directory couldn't be searched; the other groups are still returned.",
        tags: ["Auth & Sessions"],
        querystring: z.object({
          q: z.string().max(200).default(""),
          limit: z.coerce.number().int().min(1).max(50).default(50),
        }),
        response: { 200: z.unknown(), 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (!isAuthDisabled() && !req.user) {
        return reply.status(401).send({ error: "Authentication required" });
      }
      reply.send(await searchSignInGroups(req.query.q, req.query.limit));
    },
  );
}
