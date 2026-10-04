/**
 * The Connections catalog against real Postgres: provider connections, bare
 * secrets, and hand-written MCP servers as one list, each saying whose it
 * is and what it gives the agent; deployment secrets left out; private rows
 * only for their owner (and, by name, admins); defaults marked for a piece
 * of work.
 */
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { connectionCatalog } from "./connection-catalog-service.js";
import { createConnection, seedBuiltInProviders } from "./connection-service.js";
import { createMcpServer } from "./mcp-server-service.js";
import { storeSecret } from "./secret-service.js";
import { environmentOptions } from "./agent-environment-service.js";

const uniq = () => randomBytes(4).toString("hex");

beforeAll(async () => {
  await seedBuiltInProviders();
});

async function person(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `cat-${uniq()}`,
      email: `${uniq()}@cat.it`,
      displayName: name,
    })
    .returning();
  return row;
}

describe("connectionCatalog", () => {
  it("lists the three kinds with parts and owner, leaving deployment secrets out", async () => {
    const ws = await insertWorkspace();
    const jon = await person("Jon");
    const sam = await person("Sam");
    const aws = await createConnection(
      {
        name: "Acme AWS",
        providerSlug: "aws",
        config: { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" },
        assignments: [{ repoId: null }],
      },
      ws.id,
    );
    const mine = await createConnection(
      {
        name: "Jon's Linear",
        providerSlug: "linear",
        config: { LINEAR_API_KEY: "k" },
        ownerUserId: jon.id,
      },
      ws.id,
    );
    const sams = await createConnection(
      {
        name: "Sam's Notion",
        providerSlug: "notion",
        config: { NOTION_API_KEY: "n" },
        ownerUserId: sam.id,
      },
      ws.id,
    );
    const server = await createMcpServer({ name: `docs-${uniq()}`, command: "docs-mcp" }, ws.id);
    const secretName = `STRIPE_KEY_${uniq().toUpperCase()}`;
    await storeSecret(secretName, "sk", "global");
    await storeSecret("GITHUB_TOKEN", "ghp", "global");

    const jonView = await connectionCatalog({ userId: jon.id, workspaceId: ws.id, isAdmin: false });
    const byId = (id: string) => jonView.find((e) => e.id === id);
    expect(byId(aws.id)).toMatchObject({
      kind: "connection",
      icon: "aws",
      parts: ["credentials", "env", "note"],
      providerSlug: "aws",
      ownerUserId: null,
      default: false,
    });
    expect(byId(mine.id)).toMatchObject({ kind: "connection", private: true, ownerName: "Jon" });
    // A member doesn't see someone else's private connection.
    expect(byId(sams.id)).toBeUndefined();
    expect(byId(server.id)).toMatchObject({
      kind: "mcpServer",
      parts: ["tools"],
      providerName: "MCP server",
    });
    const secret = jonView.find((e) => e.kind === "secret" && e.id === secretName);
    expect(secret).toMatchObject({ parts: ["credentials"], scope: "global", default: false });
    expect(jonView.some((e) => e.kind === "secret" && e.id === "GITHUB_TOKEN")).toBe(false);

    // An admin sees Sam's, named.
    const adminView = await connectionCatalog({
      userId: jon.id,
      workspaceId: ws.id,
      isAdmin: true,
    });
    expect(adminView.find((e) => e.id === sams.id)).toMatchObject({
      private: true,
      ownerName: "Sam",
    });
  });

  it("marks what is on by default for a piece of work, and the environment carries the catalog", async () => {
    const ws = await insertWorkspace();
    const assigned = await createConnection(
      {
        name: "Pylon",
        providerSlug: "pylon",
        config: { PYLON_API_TOKEN: "t" },
        assignments: [{ repoId: null }],
      },
      ws.id,
    );
    const loose = await createConnection(
      {
        name: "Sentry",
        providerSlug: "sentry",
        config: { SENTRY_AUTH_TOKEN: "s", SENTRY_ORG: "acme" },
      },
      ws.id,
    );
    const server = await createMcpServer({ name: `global-${uniq()}`, command: "g" }, ws.id);

    const forWork = await connectionCatalog(
      { userId: null, workspaceId: ws.id, isAdmin: false },
      { repoUrl: null, agentType: "claude-code", ownerUserId: null },
    );
    expect(forWork.find((e) => e.id === assigned.id)?.default).toBe(true);
    expect(forWork.find((e) => e.id === loose.id)?.default).toBe(false);
    expect(forWork.find((e) => e.id === server.id)?.default).toBe(true);
    // Defaults come first.
    expect(forWork[0].default).toBe(true);

    const options = await environmentOptions({
      repoUrl: null,
      agentType: "claude-code",
      workspaceId: ws.id,
      ownerUserId: null,
    });
    expect(options.catalog.map((e) => e.id)).toEqual(forWork.map((e) => e.id));
  });
});
