/**
 * A disabled account's own work doesn't run again (owner-standing.ts), against
 * real Postgres: personal work of a disabled person is refused with a
 * ModelProviderError (the task worker fails it at once); their team's work,
 * organization work and an active person's work are not.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { ModelProviderError } from "./model-provider-service.js";
import { DisabledOwnerError, assertOwnerActive, disabledOwnerOf } from "./owner-standing.js";

let active: string;
let disabled: string;
let disabledEmail: string;

async function person(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: randomUUID(),
      email: `${name}.${randomUUID().slice(0, 8)}@example.test`,
      displayName: name,
    })
    .returning({ id: users.id, email: users.email });
  return row;
}

beforeAll(async () => {
  active = (await person("ada")).id;
  const gone = await person("carol");
  disabled = gone.id;
  disabledEmail = gone.email;
  await db
    .update(users)
    .set({ disabledAt: new Date(), disabledReason: "disabled_in_directory" })
    .where(eq(users.id, disabled));
});

describe("a disabled account's own work", () => {
  it("is refused, with a message naming whose it was and what to do", async () => {
    const work = { ownerUserId: disabled, ownerTeamId: null };
    expect(await disabledOwnerOf(work)).toBe(disabledEmail);
    const refused = await assertOwnerActive(work).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(DisabledOwnerError);
    // The task worker fails a ModelProviderError at once instead of retrying it.
    expect(refused).toBeInstanceOf(ModelProviderError);
    expect((refused as ModelProviderError).status).toBe(403);
    expect((refused as Error).message).toContain(disabledEmail);
    expect((refused as Error).message).toContain("start it again as yourself");
  });
});

describe("work that still runs", () => {
  it("an active person's own work", async () => {
    await expect(assertOwnerActive({ ownerUserId: active, ownerTeamId: null })).resolves.toBe(
      undefined,
    );
  });

  it("a team's work, even when its creator left (it stays the team's)", async () => {
    const work = { ownerUserId: disabled, ownerTeamId: randomUUID() };
    expect(await disabledOwnerOf(work)).toBeNull();
    await expect(assertOwnerActive(work)).resolves.toBe(undefined);
  });

  it("organization work (no owner), and an owner who is no longer there", async () => {
    await expect(assertOwnerActive({ ownerUserId: null, ownerTeamId: null })).resolves.toBe(
      undefined,
    );
    expect(await disabledOwnerOf({ ownerUserId: randomUUID(), ownerTeamId: null })).toBeNull();
  });
});
