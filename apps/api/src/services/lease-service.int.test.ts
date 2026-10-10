/**
 * Leases against the real database: two instances contending for one key,
 * expiry, renewal, release, seizure, and `withLease` giving up cleanly when
 * the lease is taken from under it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  LeaseLostError,
  acquireLease,
  leaseHolder,
  releaseLease,
  renewLease,
  seizeLease,
  sweepLeases,
  withLease,
} from "./lease-service.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const A = "api-a:111111";
const B = "api-b:222222";

afterEach(async () => {
  await db.execute(sql`DELETE FROM "leases"`);
});

describe("leases", () => {
  it("exactly one of two contending instances gets a free key", async () => {
    const key = "poller:test";
    const [a, b] = await Promise.all([acquireLease(key, 5_000, A), acquireLease(key, 5_000, B)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const holder = await leaseHolder(key);
    expect(holder).toBe(a ? A : B);
  });

  it("the holder can re-acquire (extend); another instance cannot until it expires", async () => {
    const key = "poller:extend";
    expect(await acquireLease(key, 300, A)).toBe(true);
    expect(await acquireLease(key, 300, B)).toBe(false);
    expect(await acquireLease(key, 300, A)).toBe(true);
    await sleep(400);
    expect(await acquireLease(key, 5_000, B)).toBe(true);
    expect(await leaseHolder(key)).toBe(B);
  });

  it("renew extends only a live lease of the holder; release ends it", async () => {
    const key = "poller:renew";
    expect(await acquireLease(key, 400, A)).toBe(true);
    expect(await renewLease(key, 5_000, B)).toBe(false);
    expect(await renewLease(key, 5_000, A)).toBe(true);
    await releaseLease(key, B); // not the holder: no effect
    expect(await leaseHolder(key)).toBe(A);
    await releaseLease(key, A);
    expect(await leaseHolder(key)).toBeNull();
    expect(await renewLease(key, 5_000, A)).toBe(false);
    expect(await acquireLease(key, 5_000, B)).toBe(true);
  });

  it("an expired lease cannot be renewed back to life", async () => {
    const key = "poller:expired";
    expect(await acquireLease(key, 200, A)).toBe(true);
    await sleep(300);
    expect(await renewLease(key, 5_000, A)).toBe(false);
  });

  it("seize takes a live lease from its holder", async () => {
    const key = "local-host:h1";
    expect(await acquireLease(key, 5_000, A)).toBe(true);
    await seizeLease(key, 5_000, B);
    expect(await leaseHolder(key)).toBe(B);
    expect(await renewLease(key, 5_000, A)).toBe(false);
  });

  it("rejects empty and oversized keys", async () => {
    await expect(acquireLease("", 1000, A)).rejects.toThrow(/Invalid lease key/);
    await expect(acquireLease("x".repeat(201), 1000, A)).rejects.toThrow(/Invalid lease key/);
  });

  it("sweeps leases that expired more than a day ago", async () => {
    await db.execute(sql`
      INSERT INTO "leases" ("key", "holder", "expires_at")
      VALUES ('old', 'x', now() - interval '2 days'), ('recent', 'x', now() - interval '1 hour')`);
    expect(await sweepLeases()).toBe(1);
    const rows = await db.execute<{ key: string }>(sql`SELECT "key" FROM "leases" ORDER BY "key"`);
    expect(rows.map((r) => r.key)).toEqual(["recent"]);
  });
});

describe("withLease", () => {
  it("runs fn under the lease, renews while it runs, and releases afterwards", async () => {
    const key = "poller:with";
    const result = await withLease(
      key,
      async () => {
        await sleep(700);
        expect(await leaseHolder(key)).toBe(A);
        return "done";
      },
      { ttlMs: 500, renewEveryMs: 150, holder: A },
    );
    expect(result).toBe("done");
    expect(await leaseHolder(key)).toBeNull();
  });

  it("returns null without running fn when another instance holds the lease", async () => {
    const key = "poller:busy";
    expect(await acquireLease(key, 5_000, B)).toBe(true);
    let ran = false;
    const result = await withLease(
      key,
      async () => {
        ran = true;
        return 1;
      },
      { holder: A },
    );
    expect(result).toBeNull();
    expect(ran).toBe(false);
  });

  it("aborts fn and rejects with LeaseLostError when the lease is taken away", async () => {
    const key = "poller:lost";
    let aborted = false;
    const run = withLease(
      key,
      async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        });
        return "should not count";
      },
      { ttlMs: 1_000, renewEveryMs: 100, holder: A },
    );
    await sleep(150);
    await seizeLease(key, 5_000, B);
    await expect(run).rejects.toBeInstanceOf(LeaseLostError);
    expect(aborted).toBe(true);
    // The loser never touches the lease B now holds.
    expect(await leaseHolder(key)).toBe(B);
  });

  it("fn's own error propagates and the lease is released", async () => {
    const key = "poller:throws";
    await expect(
      withLease(
        key,
        async () => {
          throw new Error("boom");
        },
        { holder: A },
      ),
    ).rejects.toThrow("boom");
    expect(await leaseHolder(key)).toBeNull();
  });
});
