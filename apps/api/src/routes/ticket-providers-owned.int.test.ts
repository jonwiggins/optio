/**
 * Owned ticket providers under #735's rules, against real Postgres, the real
 * auth plugin and PATs: the deployment's list stays a deployment admin's,
 * a workspace's people list their own workspace's providers instead (never
 * the deployment's, never a credential), and the Issues page shows a
 * workspace's provider's tickets in that workspace only.
 */
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { ticketProviders, users, workspaceMembers } from "../db/schema.js";
import { createApiKey } from "../services/api-key-service.js";
import { foundingWorkspaceId } from "../services/founding-workspace.js";
import authPlugin from "../plugins/auth.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { ticketRoutes } from "./tickets.js";
import { issueRoutes } from "./issues.js";

// Every provider answers with one ticket named after its Linear team, so a
// caller's Issues page shows which providers it reached.
vi.mock("@optio/ticket-providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@optio/ticket-providers")>()),
  getTicketProvider: () => ({
    fetchActionableTickets: async (config: { teamId?: string }) => [
      {
        source: "linear",
        externalId: `LIN-${config.teamId}`,
        title: `Ticket of ${config.teamId}`,
        body: "",
        url: `https://linear.app/acme/issue/LIN-${config.teamId}`,
        labels: ["optio"],
        metadata: {},
      },
    ],
  }),
}));

const KEY = "lin_api_NEVER_RETURNED";
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
      email: `${randomBytes(4).toString("hex")}@owned-tickets.it`,
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
let acme: string;
let other: string;

beforeAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = "false";
  founding = (await foundingWorkspaceId()) ?? (await insertWorkspace()).id;
  acme = (await insertWorkspace()).id;
  other = (await insertWorkspace()).id;
  // Someone holds the role, so a founding-workspace admin isn't standing in.
  await user({ ws: founding, role: "admin", deploymentAdmin: true });
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

describe("a workspace's own ticket providers", () => {
  it("are listed to its people apart from the deployment's, which stay a deployment admin's", async () => {
    const acmeAdmin = await user({ ws: acme, role: "admin" });
    const created = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      headers: acmeAdmin,
      payload: { source: "linear", config: { apiKey: KEY, teamId: "ACME" } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(KEY);
    const id = created.json().provider.id;
    expect(created.json().provider).toMatchObject({ workspaceId: acme, hasToken: true });

    // The deployment's list is still a deployment admin's alone.
    const deployment = await app.inject({
      method: "GET",
      url: "/api/tickets/providers",
      headers: acmeAdmin,
    });
    expect(deployment.statusCode).toBe(403);

    const acmeMember = await user({ ws: acme, role: "member" });
    const owned = await app.inject({
      method: "GET",
      url: "/api/tickets/providers/owned",
      headers: acmeMember,
    });
    expect(owned.statusCode).toBe(200);
    expect(owned.body).not.toContain(KEY);
    const listed = owned.json().providers as Array<{ id: string; workspaceId: string | null }>;
    expect(listed).toContainEqual(expect.objectContaining({ id, hasToken: true }));
    expect(listed.every((p) => p.workspaceId === acme)).toBe(true);

    const outsider = await app.inject({
      method: "GET",
      url: "/api/tickets/providers/owned",
      headers: await user({ ws: other, role: "admin" }),
    });
    expect(outsider.statusCode).toBe(200);
    expect(outsider.json().providers.map((p: { id: string }) => p.id)).not.toContain(id);
  });

  it("show their tickets on the Issues page of their own workspace only", async () => {
    await db
      .insert(ticketProviders)
      .values({ source: "linear", config: { teamId: "OWNED" }, workspaceId: acme });
    await db.insert(ticketProviders).values({ source: "linear", config: { teamId: "DEPLOYMENT" } });
    const titles = async (headers: { authorization: string }) => {
      const res = await app.inject({ method: "GET", url: "/api/issues", headers });
      expect(res.statusCode).toBe(200);
      return (res.json().issues as Array<{ title: string }>).map((i) => i.title);
    };
    const inAcme = await titles(await user({ ws: acme, role: "viewer" }));
    expect(inAcme).toContain("Ticket of OWNED");
    expect(inAcme).not.toContain("Ticket of DEPLOYMENT");
    const inOther = await titles(await user({ ws: other, role: "admin" }));
    expect(inOther).not.toContain("Ticket of OWNED");
    expect(inOther).not.toContain("Ticket of DEPLOYMENT");
    const inFounding = await titles(await user({ ws: founding, role: "viewer" }));
    expect(inFounding).toContain("Ticket of DEPLOYMENT");
    expect(inFounding).not.toContain("Ticket of OWNED");
  });
});
