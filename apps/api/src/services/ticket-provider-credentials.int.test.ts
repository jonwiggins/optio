/**
 * The boot-time heal for ticket providers saved before their token was a
 * sensitive field (a GitLab provider on main kept `config.token` in
 * plaintext): it moves into the encrypted `ticket-provider:<id>` secret and
 * out of the row, and the provider keeps working through resolveProviderConfig.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { secrets, ticketProviders } from "../db/schema.js";
import { retrieveSecret, storeSecret } from "./secret-service.js";
import { resolveProviderConfig } from "./ticket-sync-service.js";
import {
  providerSecretName,
  sealPlaintextTicketProviderCredentials,
} from "./ticket-provider-credentials.js";

const made: string[] = [];

async function legacyProvider(source: string, config: Record<string, unknown>) {
  const [row] = await db.insert(ticketProviders).values({ source, config }).returning();
  made.push(row.id);
  return row;
}
const rowOf = async (id: string) =>
  (await db.select().from(ticketProviders).where(eq(ticketProviders.id, id)))[0];
const secretOf = async (id: string) =>
  JSON.parse(await retrieveSecret(providerSecretName(id), "ticket-provider"));

afterAll(async () => {
  if (!made.length) return;
  await db.delete(ticketProviders).where(inArray(ticketProviders.id, made));
  await db.delete(secrets).where(
    inArray(
      secrets.name,
      made.map((id) => providerSecretName(id)),
    ),
  );
});

describe("plaintext ticket provider credentials at boot", () => {
  it("moves a GitLab row's token into its secret and out of the row", async () => {
    const p = await legacyProvider("gitlab", {
      token: "glpat-legacy",
      projectPath: "acme/app",
      baseUrl: "https://gitlab.example.test",
    });
    expect(await sealPlaintextTicketProviderCredentials()).toBeGreaterThanOrEqual(1);

    const row = await rowOf(p.id);
    expect(row.config).toEqual({ projectPath: "acme/app", baseUrl: "https://gitlab.example.test" });
    expect(JSON.stringify(row.config)).not.toContain("glpat-legacy");
    expect(await secretOf(p.id)).toEqual({ token: "glpat-legacy" });
    // The provider still works with it.
    expect(await resolveProviderConfig(row)).toMatchObject({
      token: "glpat-legacy",
      projectPath: "acme/app",
    });
  });

  it("keeps a value already in the secret, and the secret's other fields", async () => {
    const p = await legacyProvider("gitlab", { token: "glpat-old", projectPath: "acme/app" });
    await storeSecret(
      providerSecretName(p.id),
      JSON.stringify({ token: "glpat-current", webhookSecret: "w" }),
      "ticket-provider",
    );
    await sealPlaintextTicketProviderCredentials();
    expect((await rowOf(p.id)).config).toEqual({ projectPath: "acme/app" });
    expect(await secretOf(p.id)).toEqual({ token: "glpat-current", webhookSecret: "w" });
  });

  it("strips an empty token without writing a secret", async () => {
    const p = await legacyProvider("gitlab", { token: "", projectPath: "acme/app" });
    await sealPlaintextTicketProviderCredentials();
    expect((await rowOf(p.id)).config).toEqual({ projectPath: "acme/app" });
    await expect(retrieveSecret(providerSecretName(p.id), "ticket-provider")).rejects.toThrow(
      /Secret not found/,
    );
  });

  it("leaves rows without plaintext credentials alone, and is idempotent", async () => {
    const p = await legacyProvider("gitlab", { projectPath: "acme/clean" });
    const before = await rowOf(p.id);
    await sealPlaintextTicketProviderCredentials();
    expect(await sealPlaintextTicketProviderCredentials()).toBe(0);
    const after = await rowOf(p.id);
    expect(after.config).toEqual({ projectPath: "acme/clean" });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("keeps the round trip settings saved on the row", async () => {
    const p = await legacyProvider("gitlab", {
      token: "glpat-rt",
      projectPath: "acme/app",
      roundTrip: { enabled: true, followUps: "mention" },
    });
    await sealPlaintextTicketProviderCredentials();
    expect((await rowOf(p.id)).config).toEqual({
      projectPath: "acme/app",
      roundTrip: { enabled: true, followUps: "mention" },
    });
  });
});
