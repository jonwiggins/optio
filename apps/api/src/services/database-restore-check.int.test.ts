/**
 * Integration: the encryption-key check after a restore
 * (database-restore-check.ts and the CLI restore-db.sh runs in the API pod,
 * scripts/check-encryption-key.ts) against the per-file database: the key
 * opens secrets of every scope, and every other kind of sealed value as each
 * service seals it; another key opens none and the CLI says so with exit
 * status 1; a drill's database next to the live one is checked and dropped —
 * only one a drill made, never the live one, a restore's kept one or anyone
 * else's; the restore lands in the action log with no workspace and no
 * person, even when the check can't run.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { optioActions, secrets, users } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { createConnection, seedBuiltInProviders } from "./connection-service.js";
import {
  checkEncryptionKeyAt,
  connectTo,
  DRILL_DATABASE_MARK,
  databaseOf,
  databaseUrlFor,
  dropDrillDatabase,
  recordRestore,
  SEALED_SOURCES,
} from "./database-restore-check.js";
import { createModelProvider } from "./model-provider-service.js";
import { createRepo, updateRepo } from "./repo-service.js";
import { storeSecret } from "./secret-service.js";
import { saveSignInConfig } from "./sign-in-config-service.js";
import { createWebhook } from "./webhook-service.js";

const uniq = () => randomBytes(4).toString("hex");
const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE = () => process.env.DATABASE_URL!;

/** The CLI as restore-db.sh runs it: its exit status and what it printed. */
function cli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      join(API_DIR, "node_modules/.bin/tsx"),
      ["scripts/check-encryption-key.ts", ...args],
      { cwd: API_DIR, env: { ...process.env, ...env }, timeout: 90_000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 99) : 0;
        resolve({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}

async function databaseExists(name: string): Promise<boolean> {
  const rows = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM pg_database WHERE datname = ${name}`,
  );
  return rows[0].n === 1;
}

/** Databases a test made that may be left behind (dropped at the end). */
const made: string[] = [];

/** A drill's database, marked as the backup job marks it: a `secrets` table holding copies of the live rows. */
async function makeDrill(): Promise<string> {
  const name = `optio_drillchk_${uniq()}`;
  await db.execute(sql.raw(`CREATE DATABASE "${name}"`));
  made.push(name);
  await db.execute(
    sql.raw(
      `COMMENT ON DATABASE "${name}" IS '${DRILL_DATABASE_MARK} of optio-20261024T021500Z.dump'`,
    ),
  );
  const drill = connectTo(databaseUrlFor(LIVE(), name));
  try {
    await drill.db.execute(
      sql.raw(`CREATE TABLE secrets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
        scope text NOT NULL DEFAULT 'global', encrypted_value bytea NOT NULL, iv bytea NOT NULL,
        auth_tag bytea NOT NULL, alg smallint NOT NULL DEFAULT 1, workspace_id uuid, user_id uuid,
        team_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now())`),
    );
    const rows = await db.select().from(secrets);
    if (rows.length) await drill.db.insert(secrets).values(rows);
  } finally {
    await drill.close();
  }
  return name;
}

/** A database of someone else's on the same server, with a row in it. */
async function makeOthers(name: string): Promise<void> {
  await db.execute(sql.raw(`CREATE DATABASE "${name}"`));
  made.push(name);
  const other = connectTo(databaseUrlFor(LIVE(), name));
  try {
    await other.db.execute(sql.raw(`CREATE TABLE important (note text)`));
    await other.db.execute(sql.raw(`INSERT INTO important VALUES ('keep me')`));
  } finally {
    await other.close();
  }
}

async function noteIn(name: string): Promise<string | undefined> {
  const other = connectTo(databaseUrlFor(LIVE(), name));
  try {
    const rows = await other.db.execute<{ note: string }>(sql`SELECT note FROM important`);
    return rows[0]?.note;
  } finally {
    await other.close();
  }
}

const person = async (label: string) =>
  (
    await db
      .insert(users)
      .values({
        provider: "oidc",
        externalId: `it-${uniq()}`,
        email: `it-${label}-${uniq()}@example.com`,
        displayName: `IT ${label}`,
      })
      .returning()
  )[0];

beforeAll(async () => {
  const ws = await insertWorkspace();
  const user = await person("person");
  const boss = await person("admin");
  await storeSecret(`IT_GLOBAL_${uniq()}`, "global-value");
  await storeSecret(`IT_USER_${uniq()}`, "user-value", "user", null, user.id);
  await storeSecret(`IT_WS_${uniq()}`, "workspace-value", "workspace", ws.id);

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
      credentials: { type: "access-key", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s3cret" },
    },
    viewer,
  );
  await seedBuiltInProviders();
  await createConnection(
    {
      name: "Reporting database",
      providerSlug: "postgres",
      config: { POSTGRES_URL: "postgres://reader:pw@reports.example.test:5432/reports" },
      assignments: [{ repoId: null }],
    },
    ws.id,
  );
  await createWebhook(
    { url: `https://hooks.example.test/${uniq()}`, events: ["task.completed"], secret: "whsec-1" },
    undefined,
    ws.id,
  );
  const repo = await createRepo({
    repoUrl: `https://gitlab.example.test/platform/r-${uniq()}`,
    fullName: `platform/r-${uniq()}`,
    workspaceId: ws.id,
  });
  await updateRepo(repo.id, { slackWebhookUrl: "https://chat.example.test/hooks/T1" });
  await saveSignInConfig("google", { clientId: "db-id", clientSecret: "db-secret" }, null);
});

afterAll(async () => {
  for (const name of made) {
    await db.execute(sql.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  }
});

describe("checkEncryptionKeyAt", () => {
  it("opens the secrets of every scope under the key they were stored with", async () => {
    const r = await checkEncryptionKeyAt(LIVE());
    expect(r.verdict).toBe("ok");
    expect(r.checked).toBeGreaterThanOrEqual(3);
    expect(r.opened).toBe(r.checked);
    expect(r.failed).toEqual([]);
  });

  it("opens every kind of sealed value as its own service sealed it (the AADs agree)", async () => {
    const r = await checkEncryptionKeyAt(LIVE());
    expect(r.sources.map((s) => s.source).sort()).toEqual(
      SEALED_SOURCES.map((s) => s.label).sort(),
    );
    for (const s of r.sources) {
      expect(s, s.source).toMatchObject({ opened: s.checked });
      expect(s.checked, s.source).toBeGreaterThanOrEqual(1);
    }
  });

  it("leaves out the kinds a drill's older database has no table for", async () => {
    const drill = await makeDrill(); // a `secrets` table only
    const r = await checkEncryptionKeyAt(databaseUrlFor(LIVE(), drill));
    expect(r.verdict).toBe("ok");
    expect(r.sources.map((s) => s.source)).toEqual(["stored tokens"]);
    expect(await dropDrillDatabase(LIVE(), drill)).toBe(true);
  });
});

describe("scripts/check-encryption-key.ts", () => {
  it("says the key opens them, exit status 0", async () => {
    const { code, out } = await cli([]);
    expect(code).toBe(0);
    expect(out).toMatch(/encryption key: opens (\d+) of \1 stored secrets in /);
  });

  it("with another key: opens none, says the dump and the key don't belong together, exit status 1", async () => {
    const { code, out } = await cli([], { OPTIO_ENCRYPTION_KEY: "9".repeat(64) });
    expect(code).toBe(1);
    expect(out).toMatch(/opens 0 of \d+ stored secrets/);
    expect(out).toContain("is not the key these secrets were stored with");
    expect(out).not.toContain("global-value");
  });

  it("checks a drill's database next to the live one, then drops it", async () => {
    const drill = await makeDrill();
    expect(await databaseExists(drill)).toBe(true);
    const { code, out } = await cli(["--database", drill, "--drop-after"]);
    expect(code).toBe(0);
    expect(out).toMatch(new RegExp(`opens (\\d+) of \\1 stored secrets in ${drill}`));
    expect(out).toContain(`dropped the drill's database ${drill}`);
    expect(await databaseExists(drill)).toBe(false);
    // The live database is still there and still answers.
    expect(await databaseExists(databaseOf(LIVE()))).toBe(true);
  });

  it("refuses the live database as a drill's, and dropping without one", async () => {
    const live = databaseOf(LIVE());
    const named = await cli(["--database", live, "--drop-after"]);
    expect(named.code).toBe(2);
    expect(named.out).toContain("is the live database");
    expect(await databaseExists(live)).toBe(true);
    const bare = await cli(["--drop-after"]);
    expect(bare.code).toBe(2);
    await expect(dropDrillDatabase(LIVE(), live)).rejects.toThrow(/is the live database/);
    expect(await databaseExists(live)).toBe(true);
  });

  it("never drops a database no drill made (another environment's on the same server): exit status 2, left as it was", async () => {
    const other = `optio_someone_${uniq()}`;
    await makeOthers(other);
    const { code, out } = await cli(["--database", other, "--drop-after"]);
    expect(code).toBe(2);
    expect(out).toContain(`Couldn't drop ${other}`);
    expect(out).toContain("wasn't made by a restore drill");
    expect(await databaseExists(other)).toBe(true);
    expect(await noteIn(other)).toBe("keep me");
    await expect(dropDrillDatabase(LIVE(), other)).rejects.toThrow(
      /wasn't made by a restore drill/,
    );
    expect(await noteIn(other)).toBe("keep me");
  });

  it("refuses a restore's kept database by its name, before reading it", async () => {
    const kept = `optio_before_${uniq()}`;
    await makeOthers(kept);
    // Even marked: a restore's names are never a drill's.
    await db.execute(sql.raw(`COMMENT ON DATABASE "${kept}" IS '${DRILL_DATABASE_MARK}'`));
    const { code, out } = await cli(["--database", kept, "--drop-after"]);
    expect(code).toBe(2);
    expect(out).toContain("a restore keeps or makes");
    expect(out).not.toContain("encryption key:");
    expect(await noteIn(kept)).toBe("keep me");
    await expect(dropDrillDatabase(LIVE(), kept)).rejects.toThrow(/a restore keeps or makes/);
    expect(await noteIn(kept)).toBe("keep me");
  });

  it("says the check couldn't run (exit status 2, not 1) when the drill's database isn't there", async () => {
    const gone = `optio_gone_${uniq()}`;
    const { code, out } = await cli(["--database", gone, "--drop-after"]);
    expect(code).toBe(2);
    expect(out).toContain(`The key check couldn't read ${gone}`);
    expect(out).toContain(`no database ${gone} to drop`);
    expect(out).not.toContain("It opens none");
  });

  it("records the restore: no workspace, no person, the dump and the kept database", async () => {
    const dump = `optio-20261024T0215${String(Math.floor(Math.random() * 90) + 10)}Z.dump`;
    const { code, out } = await cli([
      "--record-restore",
      dump,
      "--kept-as",
      "optio_before_20261024101500",
    ]);
    expect(code).toBe(0);
    expect(out).toContain(`action log: database restored from ${dump}`);
    // Recorded before the check runs: a check that fails can't skip it.
    expect(out.indexOf("action log:")).toBeLessThan(out.indexOf("encryption key:"));
    const [row] = await db
      .select()
      .from(optioActions)
      .where(eq(optioActions.action, "database.restored"))
      .orderBy(desc(optioActions.createdAt))
      .limit(1);
    expect(row).toMatchObject({ workspaceId: null, userId: null, success: true });
    expect(row.result).toEqual({ dump, keptAs: "optio_before_20261024101500" });
  });

  it("recordRestore without a kept database (an in-place restore)", async () => {
    await recordRestore({ dump: "optio-20261024T021501Z-pre-upgrade.dump" });
    const [row] = await db
      .select()
      .from(optioActions)
      .where(eq(optioActions.action, "database.restored"))
      .orderBy(desc(optioActions.createdAt))
      .limit(1);
    expect(row.result).toEqual({ dump: "optio-20261024T021501Z-pre-upgrade.dump" });
  });
});
