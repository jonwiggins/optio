/**
 * Ticket providers are a workspace's. Real Postgres, the real auth plugin and
 * PATs: a workspace admin lists and changes its own workspace's providers
 * only, the list never returns credentials (GitLab tokens included), an older
 * GitLab row's plaintext token is moved into the secret store at boot, the
 * Issues page shows a workspace its own providers' tickets, and the sweep
 * matches a provider's tickets against its own workspace's repos only.
 */
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks, ticketProviders, users, workspaceMembers } from "../db/schema.js";
import { createApiKey } from "../services/api-key-service.js";
import { foundingWorkspaceId } from "../services/founding-workspace.js";
import { retrieveSecret, storeSecret } from "../services/secret-service.js";
import { sealPlaintextTicketProviderCredentials } from "../services/ticket-provider-credentials.js";
import authPlugin from "../plugins/auth.js";
import { insertRepo, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { syncAllTickets } from "../services/ticket-sync-service.js";
import { ticketRoutes } from "./tickets.js";
import { issueRoutes } from "./issues.js";

// The Issues page asks each provider for its tickets; here every provider
// answers with one, so what a caller sees is decided by the route alone.
vi.mock("@optio/ticket-providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@optio/ticket-providers")>()),
  getTicketProvider: () => ({
    fetchTicketComments: async () => [],
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

  it("refuses members and viewers; another workspace's admin sees and changes only its own", async () => {
    for (const headers of [
      await user({ ws: foreign, role: "viewer" }),
      await user({ ws: founding, role: "member" }),
    ]) {
      const res = await app.inject({ method: "GET", url: "/api/tickets/providers", headers });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain(TOKEN);
    }

    const foundingProvider = (
      await app.inject({
        method: "POST",
        url: "/api/tickets/providers",
        headers: deploymentAdmin,
        payload: { source: "linear", config: { teamId: "FOUNDING", apiKey: "lin-founding" } },
      })
    ).json().provider;

    const foreignAdmin = await user({ ws: foreign, role: "admin" });
    const foreignProvider = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      headers: foreignAdmin,
      payload: { source: "linear", config: { teamId: "FOREIGN", apiKey: "lin-foreign" } },
    });
    expect(foreignProvider.statusCode).toBe(201);
    const [stored] = await db
      .select({ workspaceId: ticketProviders.workspaceId })
      .from(ticketProviders)
      .where(eq(ticketProviders.id, foreignProvider.json().provider.id));
    expect(stored.workspaceId).toBe(foreign);

    const ids = async (headers: { authorization: string }) =>
      (
        (await app.inject({ method: "GET", url: "/api/tickets/providers", headers })).json()
          .providers as Array<{ id: string }>
      ).map((p) => p.id);
    expect(await ids(foreignAdmin)).toEqual([foreignProvider.json().provider.id]);
    expect(await ids(deploymentAdmin)).toContain(foundingProvider.id);
    expect(await ids(deploymentAdmin)).not.toContain(foreignProvider.json().provider.id);

    // Another workspace's provider is a 404, never changed.
    for (const req of [
      { method: "PATCH" as const, url: `/api/tickets/providers/${foundingProvider.id}/re-enable` },
      { method: "DELETE" as const, url: `/api/tickets/providers/${foundingProvider.id}` },
    ]) {
      expect((await app.inject({ ...req, headers: foreignAdmin })).statusCode).toBe(404);
    }
    const [still] = await db
      .select()
      .from(ticketProviders)
      .where(eq(ticketProviders.id, foundingProvider.id));
    expect(still).toBeDefined();
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

describe("the Issues page and a workspace's ticket providers", () => {
  it("shows a workspace its own providers' tickets, not another workspace's", async () => {
    // A row with no workspace (saved with auth disabled): the founding workspace's.
    await db.insert(ticketProviders).values({ source: "linear", config: { teamId: "T" } });
    const titles = async (headers: { authorization: string }) => {
      const res = await app.inject({ method: "GET", url: "/api/issues", headers });
      expect(res.statusCode).toBe(200);
      return (res.json().issues as Array<{ title: string }>).map((i) => i.title);
    };
    expect(await titles(await user({ ws: founding, role: "viewer" }))).toContain(
      "Deployment ticket",
    );
    // A third workspace with no providers of its own sees none — a deployment
    // admin too: the page shows the current workspace's providers.
    const third = (await insertWorkspace()).id;
    expect(await titles(await user({ ws: third, role: "admin" }))).not.toContain(
      "Deployment ticket",
    );
    expect(
      await titles(await user({ ws: third, role: "member", deploymentAdmin: true })),
    ).not.toContain("Deployment ticket");

    // Its own provider's tickets it does see.
    await db
      .insert(ticketProviders)
      .values({ source: "linear", config: { teamId: "THIRD" }, workspaceId: third });
    expect(await titles(await user({ ws: third, role: "viewer" }))).toContain("Deployment ticket");
  });
});

describe("the ticket sweep and a workspace's repos", () => {
  it("starts work only in the provider's own workspace's repos", async () => {
    const tag = randomBytes(4).toString("hex");
    const sweepA = (await insertWorkspace()).id;
    const sweepB = (await insertWorkspace()).id;
    const repoA = `https://github.com/acme/sweep-a-${tag}`;
    const repoB = `https://github.com/acme/sweep-b-${tag}`;
    await insertRepo({ repoUrl: repoA, fullName: `acme/sweep-a-${tag}`, workspaceId: sweepA });
    await insertRepo({ repoUrl: repoB, fullName: `acme/sweep-b-${tag}`, workspaceId: sweepB });
    // Every other provider in this file stays out of the sweep.
    await db.update(ticketProviders).set({ enabled: false });
    // Workspace A's provider pointed at B's repo, and at its own.
    await db.insert(ticketProviders).values([
      { source: "linear", config: { teamId: "A1", repoUrl: repoB }, workspaceId: sweepA },
      { source: "linear", config: { teamId: "A2", repoUrl: repoA }, workspaceId: sweepA },
    ]);

    await syncAllTickets();

    const made = await db
      .select({ repoUrl: tasks.repoUrl, workspaceId: tasks.workspaceId })
      .from(tasks)
      .where(eq(tasks.ticketExternalId, "LIN-1"));
    expect(made).toContainEqual({ repoUrl: repoA, workspaceId: sweepA });
    expect(made.map((t) => t.repoUrl)).not.toContain(repoB);
  });
});
