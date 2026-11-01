/**
 * Ticket providers are the deployment's, not one workspace's. Real Postgres,
 * the real auth plugin and PATs: the provider list takes a deployment admin
 * and never returns credentials (GitLab tokens included), an older GitLab
 * row's plaintext token is moved into the secret store at boot, and the
 * Issues page shows the providers' tickets to the founding workspace and
 * deployment admins only.
 */
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { ticketProviders, users, workspaceMembers } from "../db/schema.js";
import { createApiKey } from "../services/api-key-service.js";
import { foundingWorkspaceId } from "../services/founding-workspace.js";
import { retrieveSecret, storeSecret } from "../services/secret-service.js";
import { sealPlaintextTicketProviderCredentials } from "../services/ticket-provider-credentials.js";
import authPlugin from "../plugins/auth.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { ticketRoutes } from "./tickets.js";
import { issueRoutes } from "./issues.js";

// The Issues page asks each provider for its tickets; here every provider
// answers with one, so what a caller sees is decided by the route alone.
vi.mock("@optio/ticket-providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@optio/ticket-providers")>()),
  getTicketProvider: () => ({
    fetchActionableTickets: async () => [
      {
        source: "linear",
        externalId: "LIN-1",
        title: "Deployment ticket",
        body: "only the deployment's people see this",
        url: "https://linear.app/acme/issue/LIN-1",
        labels: ["optio"],
        metadata: {},
      },
    ],
  }),
}));

const TOKEN = "glpat-NEVER-RETURNED";
let app: FastifyInstance;
const savedAuth = process.env.OPTIO_AUTH_DISABLED;

async function user(opts: {
  ws: string;
  role: "admin" | "member" | "viewer";
  deploymentAdmin?: boolean;
}) {
  const [u] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${randomBytes(5).toString("hex")}`,
      email: `${randomBytes(4).toString("hex")}@tickets.it`,
      emailVerified: true,
      displayName: "it",
      defaultWorkspaceId: opts.ws,
      deploymentAdmin: !!opts.deploymentAdmin,
    })
    .returning();
  await db.insert(workspaceMembers).values({ workspaceId: opts.ws, userId: u.id, role: opts.role });
  return { authorization: `Bearer ${(await createApiKey(u.id, "it")).token}` };
}

let founding: string;
let foreign: string;
let deploymentAdmin: { authorization: string };

beforeAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = "false";
  founding = (await foundingWorkspaceId()) ?? (await insertWorkspace()).id;
  foreign = (await insertWorkspace()).id;
  // Someone holds the role, so a founding-workspace admin isn't standing in.
  deploymentAdmin = await user({ ws: founding, role: "admin", deploymentAdmin: true });
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(ticketRoutes);
  await app.register(issueRoutes);
  await app.ready();
});

afterAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = savedAuth;
  await app?.close();
});

describe("ticket provider list", () => {
  it("is a deployment admin's, and never carries a credential", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      headers: deploymentAdmin,
      payload: {
        source: "gitlab",
        config: { host: "gitlab.com", token: TOKEN, projectPath: "acme/app" },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(TOKEN);
    const provider = created.json().provider;
    expect(provider.hasToken).toBe(true);
    expect(provider.config).toEqual({ host: "gitlab.com", projectPath: "acme/app" });

    // Stored encrypted with the provider, not in its row.
    const [row] = await db
      .select()
      .from(ticketProviders)
      .where(eq(ticketProviders.id, provider.id));
    expect(JSON.stringify(row.config)).not.toContain(TOKEN);
    expect(
      JSON.parse(await retrieveSecret(`ticket-provider:${provider.id}`, "ticket-provider")),
    ).toEqual({ token: TOKEN });

    const listed = await app.inject({
      method: "GET",
      url: "/api/tickets/providers",
      headers: deploymentAdmin,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(TOKEN);
    expect(listed.json().providers).toContainEqual(
      expect.objectContaining({ id: provider.id, hasToken: true }),
    );

    const reEnabled = await app.inject({
      method: "PATCH",
      url: `/api/tickets/providers/${provider.id}/re-enable`,
      headers: deploymentAdmin,
    });
    expect(reEnabled.statusCode).toBe(200);
    expect(reEnabled.body).not.toContain(TOKEN);
  });

  it("refuses everyone else, a founding-workspace member or another workspace's admin", async () => {
    const callers = [
      await user({ ws: foreign, role: "viewer" }),
      await user({ ws: foreign, role: "admin" }),
      await user({ ws: founding, role: "member" }),
    ];
    for (const headers of callers) {
      const res = await app.inject({ method: "GET", url: "/api/tickets/providers", headers });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain(TOKEN);
    }
  });

  it("moves an older GitLab row's plaintext token into the secret store, once", async () => {
    const [row] = await db
      .insert(ticketProviders)
      .values({
        source: "gitlab",
        config: { host: "gitlab.com", token: "glpat-OLD-PLAINTEXT", groupPath: "acme" },
      })
      .returning();
    // A Linear row with its key already sealed is left as it is.
    const [linear] = await db
      .insert(ticketProviders)
      .values({ source: "linear", config: { teamId: "T" } })
      .returning();
    await storeSecret(
      `ticket-provider:${linear.id}`,
      JSON.stringify({ apiKey: "lin" }),
      "ticket-provider",
    );

    expect(await sealPlaintextTicketProviderCredentials()).toBe(1);
    const [after] = await db.select().from(ticketProviders).where(eq(ticketProviders.id, row.id));
    expect(after.config).toEqual({ host: "gitlab.com", groupPath: "acme" });
    expect(
      JSON.parse(await retrieveSecret(`ticket-provider:${row.id}`, "ticket-provider")),
    ).toEqual({ token: "glpat-OLD-PLAINTEXT" });
    expect(await sealPlaintextTicketProviderCredentials()).toBe(0);
  });
});

describe("the Issues page and the deployment's ticket providers", () => {
  it("shows their tickets to the founding workspace and deployment admins only", async () => {
    await db.insert(ticketProviders).values({ source: "linear", config: { teamId: "T" } });
    const titles = async (headers: { authorization: string }) => {
      const res = await app.inject({ method: "GET", url: "/api/issues", headers });
      expect(res.statusCode).toBe(200);
      return (res.json().issues as Array<{ title: string }>).map((i) => i.title);
    };
    expect(await titles(await user({ ws: founding, role: "viewer" }))).toContain(
      "Deployment ticket",
    );
    expect(await titles(await user({ ws: foreign, role: "admin" }))).not.toContain(
      "Deployment ticket",
    );
    // A deployment admin sees them wherever they are.
    expect(
      await titles(await user({ ws: foreign, role: "member", deploymentAdmin: true })),
    ).toContain("Deployment ticket");
  });
});
