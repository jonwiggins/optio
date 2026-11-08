/**
 * Integration: encryption key rotation (encryption-key-rotation.ts and
 * scripts/rotate-encryption-key.ts) against the per-file database. One value
 * of every sealed column is stored through its own service under the key
 * this process runs with (the old key); the rotation re-seals all of them
 * under a new key, batch by batch, each value with its own AAD, so the
 * restore check under the new key alone opens every one and the old key
 * opens none. A dry run writes nothing, a failed batch is rolled back and the
 * next run picks up from there, and the script's exit status says whether
 * anything is left under the old key.
 */
import { execFile } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { desc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { optioActions, secrets, users } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { createConnection, seedBuiltInProviders } from "./connection-service.js";
import { ENCRYPTED_COLUMNS, STORED_TOKENS, readSealedRows } from "./encrypted-columns.js";
import { rotateEncryptionKey, verifyEncryptionKey } from "./encryption-key-rotation.js";
import { createModelProvider } from "./model-provider-service.js";
import { createConnection as createRemoteWorkspaceConnection } from "./remote-workspace-service.js";
import { createRepo, updateRepo } from "./repo-service.js";
import {
  buildSecretAAD,
  decryptWithKey,
  parseEncryptionKey,
  storeSecret,
} from "./secret-service.js";
import { saveSignInConfig } from "./sign-in-config-service.js";
import { createWebhook } from "./webhook-service.js";

const uniq = () => randomBytes(4).toString("hex");
const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "../..");
/** The key the services sealed with (this process's), and the new one, made here. */
const OLD_KEY = () => process.env.OPTIO_ENCRYPTION_KEY!;
const NEW_KEY = randomBytes(32).toString("hex");
const keys = () => ({
  current: parseEncryptionKey(NEW_KEY),
  previous: parseEncryptionKey(OLD_KEY()),
});

function script(
  name: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      join(API_DIR, "node_modules/.bin/tsx"),
      [`scripts/${name}`, ...args],
      { cwd: API_DIR, env: { ...process.env, ...env }, timeout: 90_000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 99) : 0;
        resolve({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}
const rotate = (args: string[], env: Record<string, string | undefined> = {}) =>
  script("rotate-encryption-key.ts", args, {
    OPTIO_ENCRYPTION_KEY: NEW_KEY,
    OPTIO_ENCRYPTION_KEY_PREVIOUS: OLD_KEY(),
    ...env,
  });

/** Every sealed value's blob, by column and row: to tell what a run changed. */
async function snapshot(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const column of ENCRYPTED_COLUMNS) {
    for (const { row, blob } of await readSealedRows(db, column, { limit: 10_000 })) {
      out.set(`${column.label}/${row.id}`, blob ? blob.ciphertext.toString("hex") : "");
    }
  }
  return out;
}

const PLAINTEXTS = ["global-value", "user-value", "workspace-value", "legacy-value"];
let legacyName = "";

beforeAll(async () => {
  const ws = await insertWorkspace();
  const [user, boss] = await db
    .insert(users)
    .values(
      ["person", "admin"].map((label) => ({
        provider: "oidc",
        externalId: `it-${uniq()}`,
        email: `it-${label}-${uniq()}@example.com`,
        displayName: `IT ${label}`,
      })),
    )
    .returning();
  // Enough stored tokens for several batches of 2.
  await storeSecret(`IT_GLOBAL_${uniq()}`, "global-value");
  await storeSecret(`IT_USER_${uniq()}`, "user-value", "user", null, user.id);
  await storeSecret(`IT_WS_${uniq()}`, "workspace-value", "workspace", ws.id);
  for (let i = 0; i < 4; i++) await storeSecret(`IT_MORE_${i}_${uniq()}`, `more-${i}`);
  // A legacy row: 16-byte IV, sealed without an AAD.
  legacyName = `IT_LEGACY_${uniq()}`;
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", parseEncryptionKey(OLD_KEY()), iv);
  const encryptedValue = Buffer.concat([cipher.update("legacy-value", "utf8"), cipher.final()]);
  await db.insert(secrets).values({
    name: legacyName,
    scope: "global",
    encryptedValue,
    iv,
    authTag: cipher.getAuthTag(),
    alg: 1,
  });

  // One value of every other kind, sealed by its own service.
  const viewer = { workspaceId: ws.id, userId: boss.id, isAdmin: true };
  await createModelProvider(
    {
      name: "Org Bedrock",
      owner: "workspace",
      kind: "bedrock",
      agents: ["claude-code"],
      region: "us-west-2",
      podCredential: "access-key",
      credentials: { type: "access-key", accessKeyId: "example-id", secretAccessKey: "example" },
    },
    viewer,
  );
  await seedBuiltInProviders();
  await createConnection(
    {
      name: "Reporting database",
      providerSlug: "postgres",
      config: { POSTGRES_URL: "postgres://reader:pw@reports.example.com:5432/reports" },
      assignments: [{ repoId: null }],
    },
    ws.id,
  );
  await createWebhook(
    { url: `https://hooks.example.com/${uniq()}`, events: ["task.completed"], secret: "whsec-1" },
    undefined,
    ws.id,
  );
  const repo = await createRepo({
    repoUrl: `https://gitlab.example.com/platform/r-${uniq()}`,
    fullName: `platform/r-${uniq()}`,
    workspaceId: ws.id,
  });
  await updateRepo(repo.id, { slackWebhookUrl: "https://chat.example.com/hooks/T1" });
  await saveSignInConfig("google", { clientId: "db-id", clientSecret: "db-secret" }, null);
  await createRemoteWorkspaceConnection(
    {
      provider: "coder",
      name: "Org Coder",
      url: "https://coder.example.com",
      token: "coder-tok-1",
    },
    viewer,
  );
});

describe("encryption key rotation", () => {
  it("has a value of every sealed column to rotate, all under the old key", async () => {
    const r = await verifyEncryptionKey(db, keys());
    for (const c of r.columns) expect(c.previous, c.label).toBeGreaterThanOrEqual(1);
    expect(r).toMatchObject({ current: 0, unreadable: 0 });
  });

  it("a dry run counts and writes nothing", async () => {
    const before = await snapshot();
    const { code, out } = await rotate(["--dry-run", "--batch-size", "2"]);
    expect(code, out).toBe(0);
    expect(out).toMatch(/dry run in \S+: (\d+) values would be re-sealed/);
    expect(await snapshot()).toEqual(before);
    for (const p of PLAINTEXTS) expect(out).not.toContain(p);
  });

  it("refuses to start without the old key, or with the same key twice (exit status 2)", async () => {
    const before = await snapshot();
    const missing = await rotate([], { OPTIO_ENCRYPTION_KEY_PREVIOUS: "" });
    expect(missing.code).toBe(2);
    expect(missing.out).toContain("OPTIO_ENCRYPTION_KEY_PREVIOUS (the old key) is not set");
    const same = await rotate([], { OPTIO_ENCRYPTION_KEY_PREVIOUS: NEW_KEY });
    expect(same.code).toBe(2);
    expect(await snapshot()).toEqual(before);
  });

  it("the check says values are still under the old key (exit status 1)", async () => {
    const { code, out } = await rotate(["--verify"]);
    expect(code, out).toBe(1);
    expect(out).toContain("still under the old key: run the rotation again");
  });

  it("rolls back a batch that fails, keeping the batches before it", async () => {
    const stored = ENCRYPTED_COLUMNS.find((c) => c.label === STORED_TOKENS)!;
    const rows = await readSealedRows(db, stored, { limit: 10_000 });
    const failAt = 3; // the 4th row: batch 2 (rows 2 and 3) fails part way
    const failing = {
      ...stored,
      aads: (row: Parameters<typeof stored.aads>[0]) => {
        if (row.id === rows[failAt].row.id) throw new Error("injected failure");
        return stored.aads(row);
      },
    };
    await expect(
      rotateEncryptionKey(db, keys(), { batchSize: 2, columns: [failing] }),
    ).rejects.toThrow("injected failure");
    const after = await verifyEncryptionKey(db, keys(), { columns: [stored] });
    expect(after.columns[0]).toMatchObject({ current: 2, previous: rows.length - 2 });
  });

  it("an interrupted rotation is run again: the script re-seals the rest and checks", async () => {
    const { code, out } = await rotate(["--batch-size", "2"]);
    expect(code, out).toBe(0);
    expect(out).toMatch(/rotation in \S+: re-sealed \d+ values under the new key/);
    expect(out).toMatch(/stored tokens: 2 under the new key, \d+ rotated/);
    expect(out).toContain("Every value opens with the new key");
    for (const p of PLAINTEXTS) expect(out).not.toContain(p);

    const r = await verifyEncryptionKey(db, keys());
    expect(r).toMatchObject({ previous: 0, unreadable: 0 });
    const [logged] = await db
      .select()
      .from(optioActions)
      .where(eq(optioActions.action, "secrets.key_rotated"))
      .orderBy(desc(optioActions.createdAt))
      .limit(1);
    expect(logged).toMatchObject({ workspaceId: null, userId: null, success: true });
  });

  it("re-seals each value with its service's AAD: the restore check opens all under the new key alone", async () => {
    const opened = await script("check-encryption-key.ts", [], {
      OPTIO_ENCRYPTION_KEY: NEW_KEY,
      OPTIO_ENCRYPTION_KEY_PREVIOUS: "",
    });
    expect(opened.code, opened.out).toBe(0);
    expect(opened.out).toMatch(/opens (\d+) of \1 stored secrets/);
    for (const column of ENCRYPTED_COLUMNS) expect(opened.out).toContain(column.label);

    const old = await script("check-encryption-key.ts", [], {
      OPTIO_ENCRYPTION_KEY: OLD_KEY(),
      OPTIO_ENCRYPTION_KEY_PREVIOUS: "",
    });
    expect(old.code).toBe(1);
    expect(old.out).toMatch(/opens 0 of \d+ stored secrets/);
  });

  it("upgrades the legacy row to an AAD-bound one its reader opens", async () => {
    const [row] = await db.select().from(secrets).where(eq(secrets.name, legacyName));
    expect(row.iv.length).toBe(12);
    expect(
      decryptWithKey(
        keys().current,
        { alg: row.alg, iv: row.iv, ciphertext: row.encryptedValue, authTag: row.authTag },
        buildSecretAAD(legacyName, "global", null),
      ),
    ).toBe("legacy-value");
  });

  it("running it again changes nothing", async () => {
    const before = await snapshot();
    const r = await rotateEncryptionKey(db, keys(), { batchSize: 2 });
    expect(r.rotated).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it("names a value neither key opens and exits 3, never printing a value", async () => {
    await db.insert(secrets).values({
      name: `IT_DAMAGED_${uniq()}`,
      scope: "global",
      encryptedValue: randomBytes(24),
      iv: randomBytes(12),
      authTag: randomBytes(16),
      alg: 1,
    });
    const { code, out } = await rotate(["--verify"]);
    expect(code, out).toBe(3);
    expect(out).toMatch(/neither key opens: IT_DAMAGED_\w+ \(global\)/);
    expect(out).toContain("None is left under the old key");
  });
});
