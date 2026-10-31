/**
 * Where a ticket provider's credentials live: never in the row's `config`
 * (which the API and the database restore check read), always in the
 * encrypted `ticket-provider:<id>` secret that `resolveProviderConfig`
 * (ticket-sync-service.ts) merges back in when the provider is used.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { ticketProviders } from "../db/schema.js";
import { logger } from "../logger.js";
import { retrieveSecret, storeSecret } from "./secret-service.js";

/** The config fields, per provider type, that are credentials. */
export const SENSITIVE_PROVIDER_FIELDS: Record<string, string[]> = {
  github: ["token"],
  gitlab: ["token"],
  jira: ["apiToken"],
  linear: ["apiKey"],
  notion: ["apiKey"],
};

/** The name of a provider's credentials secret (scope `ticket-provider`). */
export const providerSecretName = (id: string) => `ticket-provider:${id}`;

/**
 * Moves credentials an older row still keeps in plaintext in its `config`
 * (a GitLab provider saved before `gitlab` was listed above) into the
 * provider's secret, then takes them out of the row. A value already in the
 * secret wins, as it does in `resolveProviderConfig`. The secret is written
 * before the row changes, so a crash in between loses nothing. A secret
 * that can't be read is left alone, and so is its row. Idempotent: run at
 * boot. The number of rows healed.
 */
export async function sealPlaintextTicketProviderCredentials(): Promise<number> {
  const rows = await db
    .select({
      id: ticketProviders.id,
      source: ticketProviders.source,
      config: ticketProviders.config,
    })
    .from(ticketProviders);
  let sealed = 0;
  for (const row of rows) {
    const fields = SENSITIVE_PROVIDER_FIELDS[row.source] ?? [];
    const config = (row.config as Record<string, unknown> | null) ?? {};
    const moved: Record<string, string> = {};
    let strip = false;
    for (const f of fields) {
      if (!(f in config)) continue;
      const v = config[f];
      if (typeof v === "string" && v !== "") moved[f] = v;
      strip = true;
    }
    if (!strip) continue;
    try {
      if (Object.keys(moved).length) {
        let stored: Record<string, unknown> = {};
        try {
          stored = JSON.parse(await retrieveSecret(providerSecretName(row.id), "ticket-provider"));
        } catch (err) {
          if (!(err instanceof Error && err.message.startsWith("Secret not found"))) throw err;
        }
        await storeSecret(
          providerSecretName(row.id),
          JSON.stringify({ ...moved, ...stored }),
          "ticket-provider",
        );
      }
      // Take only these keys out (`jsonb - text[]`): a settings change saved
      // meanwhile keeps everything else.
      const keys = sql.join(
        fields.map((f) => sql`${f}`),
        sql`, `,
      );
      await db
        .update(ticketProviders)
        .set({
          config: sql`${ticketProviders.config} - ARRAY[${keys}]::text[]`,
          updatedAt: new Date(),
        })
        .where(eq(ticketProviders.id, row.id));
      sealed++;
    } catch (err) {
      logger.error(
        { err, providerId: row.id, source: row.source },
        "Could not move a ticket provider's plaintext credentials into its secret",
      );
    }
  }
  if (sealed > 0) logger.info({ sealed }, "Sealed plaintext ticket provider credentials");
  return sealed;
}
