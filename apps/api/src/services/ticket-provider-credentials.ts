/**
 * Where a ticket provider's credentials live: never in the row's `config`
 * (which the provider list returns), always in the encrypted
 * `ticket-provider:<id>` secret that the ticket sync, the Issues page and the
 * work-link status merge back in when the provider is used.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { ticketProviders } from "../db/schema.js";
import { logger } from "../logger.js";
import { listSecrets, retrieveSecret, storeSecret } from "./secret-service.js";

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

/** Postgres advisory lock for the boot-time seal, so replicas booting together take turns. */
const SEAL_ADVISORY_LOCK_ID = 8_675_312;

/**
 * A provider row as the API returns it: its config without any credential
 * (even one an older row still keeps there until the boot-time seal moves
 * it), and `hasToken`, whether it has one stored.
 */
export function publicProvider<T extends { id: string; source: string; config: unknown }>(
  row: T,
  stored: Set<string>,
): T & { hasToken: boolean } {
  const fields = SENSITIVE_PROVIDER_FIELDS[row.source] ?? [];
  const config =
    row.config && typeof row.config === "object"
      ? { ...(row.config as Record<string, unknown>) }
      : {};
  let inConfig = false;
  for (const f of fields) {
    if (typeof config[f] === "string" && config[f] !== "") inConfig = true;
    delete config[f];
  }
  return { ...row, config, hasToken: inConfig || stored.has(providerSecretName(row.id)) };
}

/** The names of the provider secrets that exist, for `publicProvider`. */
export async function storedProviderSecrets(): Promise<Set<string>> {
  return new Set((await listSecrets("ticket-provider")).map((s) => s.name));
}

/**
 * Moves credentials an older row keeps in plaintext in its `config` (a
 * GitLab provider saved before `gitlab` was listed above) into the
 * provider's secret, then takes them out of the row. A value already in the
 * secret wins, as it does when the provider is used. The secret is written
 * before the row changes, so a crash in between loses nothing; a secret that
 * can't be read leaves its row alone. Idempotent; run at boot. Returns the
 * number of rows sealed.
 */
export async function sealPlaintextTicketProviderCredentials(): Promise<number> {
  return db.transaction(async (tx) => {
    // The transaction only holds the lock (until it ends), so a second
    // replica waits here and then finds nothing left to move. Rows are read
    // and written outside it: one row's failure leaves the others sealed.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${sql.raw(String(SEAL_ADVISORY_LOCK_ID))})`);
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
      const present = fields.filter((f) => f in config);
      if (present.length === 0) continue;
      const moved: Record<string, string> = {};
      for (const f of present) {
        const v = config[f];
        if (typeof v === "string" && v !== "") moved[f] = v;
      }
      try {
        if (Object.keys(moved).length > 0) {
          let stored: Record<string, unknown> = {};
          try {
            stored = JSON.parse(
              await retrieveSecret(providerSecretName(row.id), "ticket-provider"),
            );
          } catch (err) {
            if (!(err instanceof Error && err.message.startsWith("Secret not found"))) throw err;
          }
          await storeSecret(
            providerSecretName(row.id),
            JSON.stringify({ ...moved, ...stored }),
            "ticket-provider",
          );
        }
        // Only these keys come out (`jsonb - text[]`), so nothing else in
        // the config is touched.
        const keys = sql.join(
          present.map((f) => sql`${f}`),
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
  });
}
