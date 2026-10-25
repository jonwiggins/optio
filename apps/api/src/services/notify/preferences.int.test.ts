/**
 * A person's notification choices against real Postgres
 * (services/notify/preferences.ts): switches saved at the same moment all
 * stay — Settings saves each switch as soon as it is flipped, so two quick
 * flips race, and the first choice a person ever makes has no row to lock.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { notificationPreferences, users } from "../../db/schema.js";
import { getPreferences, updatePreferences } from "../notification-service.js";
import { getChannelChoices, updateChannelChoices } from "./preferences.js";

const uniq = () => randomBytes(4).toString("hex");

async function person() {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: uniq(),
      email: `p-${uniq()}@example.test`,
      displayName: "p",
    })
    .returning();
  return row;
}

const KINDS = ["task.pr_opened", "task.needs_attention", "task.failed", "task.completed"];

describe("saving choices at the same moment", () => {
  it("keeps every switch when a new person flips several at once", async () => {
    for (let round = 0; round < 5; round++) {
      const me = await person();
      // Each one the opposite of its default, so a lost save shows.
      const flips = {
        "task.pr_opened": false,
        "task.needs_attention": false,
        "task.failed": false,
      };
      await Promise.all([
        ...Object.entries(flips).map(([kind, on]) =>
          updateChannelChoices(me.id, { email: { [kind]: on } }),
        ),
        updateChannelChoices(me.id, { email: { "task.completed": true } }),
        updateChannelChoices(me.id, { teamWork: false }),
        updateChannelChoices(me.id, { push: { "task.failed": false } }),
      ]);
      const c = await getChannelChoices(me.id);
      expect(Object.fromEntries(KINDS.map((k) => [k, c.email[k]])), `round ${round + 1}`).toEqual({
        ...flips,
        "task.completed": true,
      });
      expect(c.teamWork, `round ${round + 1}`).toBe(false);
      expect(c.push["task.failed"], `round ${round + 1}`).toBe(false);
      const rows = await db
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, me.id));
      expect(rows).toHaveLength(1);
    }
  });

  it("starts a person's row with upstream's defaults intact", async () => {
    const me = await person();
    await updateChannelChoices(me.id, { email: { "task.failed": false } });
    // The row now exists; upstream reads it with its defaults filled in.
    expect(await getPreferences(me.id)).toMatchObject({
      "task.pr_opened": { push: true },
      "task.stalled": { push: false },
    });
    // And upstream's PUT keeps the email choice.
    await updatePreferences(me.id, { "task.stalled": { push: true } });
    const c = await getChannelChoices(me.id);
    expect(c.email["task.failed"]).toBe(false);
  });
});
