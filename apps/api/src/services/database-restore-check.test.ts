import { createCipheriv, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const logAction = vi.fn();
vi.mock("./optio-action-service.js", () => ({
  logAction: (...a: unknown[]) => logAction(...a),
}));
// Each case loads the modules again under its key (vi.resetModules): only the
// crypto is real, so the schema, the ORM and the shared package stay out of it
// (re-evaluating them every time timed out under the full suite's load).
vi.mock("../db/schema.js", () => ({
  secrets: {},
  authProviderConfigs: {},
  connections: {},
  modelProviders: {},
  repos: {},
  webhooks: {},
}));
// A statement is its text: `sql` joins a template's parts, `sql.raw` keeps its string.
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  isNotNull: vi.fn(),
  isNull: vi.fn(),
  ne: vi.fn(),
  or: vi.fn(),
  sql: Object.assign((parts: TemplateStringsArray) => ({ text: parts.join("$") }), {
    raw: (text: string) => ({ text }),
  }),
}));
// A connection is its URL; what a statement does there is up to `server.answer`.
const server = vi.hoisted(() => ({
  answer: (_url: string, _text: string): unknown => [],
  ran: [] as string[],
}));
vi.mock("postgres", () => ({
  default: (url: string) => ({ url, end: async () => undefined }),
}));
vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: (client: { url: string }) => ({
    execute: async (q: { text: string }) => {
      const database = new URL(client.url).pathname.slice(1);
      server.ran.push(`${database}: ${q.text}`);
      return server.answer(database, q.text);
    },
  }),
}));

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

/** The service and the secret helpers, loaded fresh under one key (secret-service caches it). */
async function underKey(key: string) {
  vi.resetModules();
  vi.stubEnv("OPTIO_ENCRYPTION_KEY", key);
  const secret = await import("./secret-service.js");
  const check = await import("./database-restore-check.js");
  return { secret, check };
}

type Row = import("./database-restore-check.js").StoredSecretRow;

/** Rows as storeSecret seals them under KEY_A, one of each binding, plus a legacy and an old-binding row. */
async function rowsUnderA(): Promise<{ rows: Row[]; values: string[] }> {
  const { secret } = await underKey(KEY_A);
  const values: string[] = [];
  const seal = (name: string, scope: string, aadWs: string | null, rowWs: string | null): Row => {
    const value = `value-of-${name}-${randomBytes(4).toString("hex")}`;
    values.push(value);
    const blob = secret.encrypt(value, secret.buildSecretAAD(name, scope, aadWs));
    return {
      name,
      scope,
      workspaceId: rowWs,
      alg: blob.alg,
      iv: blob.iv,
      encryptedValue: blob.ciphertext,
      authTag: blob.authTag,
    };
  };
  const rows = [
    seal("GITLAB_TOKEN", "global", null, null),
    seal("LITELLM_TOKEN", "user", null, null),
    seal("WS_GITLAB_TOKEN", "workspace", "ws-1", "ws-1"),
    // A global row once bound to a workspace (before the boot-time heal).
    seal("OLD_GLOBAL", "global", "ws-2", "ws-2"),
  ];
  // Legacy: a 16-byte IV and no AAD.
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(KEY_A, "hex"), iv);
  const legacyValue = "legacy-value";
  values.push(legacyValue);
  const encryptedValue = Buffer.concat([cipher.update(legacyValue, "utf8"), cipher.final()]);
  rows.push({
    name: "LEGACY",
    scope: "global",
    workspaceId: null,
    alg: 1,
    iv,
    encryptedValue,
    authTag: cipher.getAuthTag(),
  });
  return { rows, values };
}

afterEach(() => {
  vi.unstubAllEnvs();
  logAction.mockReset();
  server.answer = () => [];
  server.ran = [];
});

describe("checkKeyOnRows", () => {
  it("opens every binding a row may have under the key it was stored with", async () => {
    const { rows } = await rowsUnderA();
    const { check } = await underKey(KEY_A);
    expect(check.checkKeyOnRows(rows)).toEqual({
      checked: 5,
      opened: 5,
      failed: [],
      verdict: "ok",
      sources: [{ source: "stored tokens", checked: 5, opened: 5 }],
    });
  });

  it("opens none under another key, and names them without their values", async () => {
    const { rows, values } = await rowsUnderA();
    const { check } = await underKey(KEY_B);
    const r = check.checkKeyOnRows(rows);
    expect(r.verdict).toBe("wrong-key");
    expect(r.opened).toBe(0);
    expect(r.failed).toEqual([
      "GITLAB_TOKEN (global)",
      "LITELLM_TOKEN (user)",
      "WS_GITLAB_TOKEN (workspace)",
      "OLD_GLOBAL (global)",
      "LEGACY (global)",
    ]);
    const shown = JSON.stringify(r);
    for (const v of values) expect(shown).not.toContain(v);
  });

  it("is ok when the key opens some and a damaged row doesn't open", async () => {
    const { rows } = await rowsUnderA();
    const damaged = { ...rows[2], encryptedValue: Buffer.from(rows[2].encryptedValue) };
    damaged.encryptedValue[0] ^= 0xff;
    const { check } = await underKey(KEY_A);
    expect(check.checkKeyOnRows([rows[0], damaged, rows[1]])).toEqual({
      checked: 3,
      opened: 2,
      failed: ["WS_GITLAB_TOKEN (workspace)"],
      verdict: "ok",
      sources: [{ source: "stored tokens", checked: 3, opened: 2 }],
    });
  });

  it("has nothing to check when nothing is stored", async () => {
    const { check } = await underKey(KEY_A);
    expect(check.checkKeyOnRows([])).toEqual({
      checked: 0,
      opened: 0,
      failed: [],
      verdict: "empty",
      sources: [],
    });
  });

  it("names at most ten rows it couldn't open", async () => {
    const { rows } = await rowsUnderA();
    const many = [...rows, ...rows, ...rows];
    const { check } = await underKey(KEY_B);
    const r = check.checkKeyOnRows(many);
    expect(r.checked).toBe(15);
    expect(r.failed).toHaveLength(10);
  });
});

describe("checkKeyOnValues: the other sealed values", () => {
  /** A value sealed under KEY_A with `aad`, as a service seals one on its own row. */
  async function sealedUnderA(source: string, label: string, aad: string) {
    const { secret } = await underKey(KEY_A);
    const blob = secret.encrypt(`value-of-${label}`, Buffer.from(aad));
    return {
      source,
      label,
      alg: blob.alg,
      iv: blob.iv,
      ciphertext: blob.ciphertext,
      authTag: blob.authTag,
      aads: [Buffer.from(aad)],
    };
  }

  it("is not 'nothing to check' when only other kinds than stored tokens hold values", async () => {
    const values = [
      await sealedUnderA(
        "model provider credentials",
        "model provider Bedrock",
        "model_provider|p1",
      ),
      await sealedUnderA(
        "webhook signing secrets",
        "webhook w1",
        "webhook:https://h.example.test/x:secret",
      ),
    ];
    const { check } = await underKey(KEY_A);
    expect(check.checkKeyOnValues(values)).toEqual({
      checked: 2,
      opened: 2,
      failed: [],
      verdict: "ok",
      sources: [
        { source: "model provider credentials", checked: 1, opened: 1 },
        { source: "webhook signing secrets", checked: 1, opened: 1 },
      ],
    });
    const other = await underKey(KEY_B);
    expect(other.check.checkKeyOnValues(values)).toMatchObject({
      opened: 0,
      verdict: "wrong-key",
      failed: ["model provider Bedrock", "webhook w1"],
    });
  });

  it("doesn't open a value under another binding (the AAD is part of the check)", async () => {
    const v = await sealedUnderA("connection secrets", "connection Reporting", "connection|c1");
    const { check } = await underKey(KEY_A);
    const elsewhere = { ...v, aads: [Buffer.from("connection|c2")] };
    expect(check.checkKeyOnValues([elsewhere]).verdict).toBe("wrong-key");
  });
});

describe("dropDrillDatabase", () => {
  const LIVE = "postgres://optio:pw@optio-postgres:5432/optio";
  const MARKED = [{ mark: "optio restore drill of optio-20261024T021500Z.dump" }];

  it("refuses the live database, a restore's names and names that aren't plain, connecting nowhere", async () => {
    const { check } = await underKey(KEY_A);
    for (const [name, why] of [
      ["optio", /is the live database/],
      ["optio_before_20261024101700", /a restore keeps or makes/],
      ["optio_restore_20261024101700", /a restore keeps or makes/],
      ['x"; DROP', /plain database name/],
    ] as const) {
      await expect(check.dropDrillDatabase(LIVE, name)).rejects.toThrow(why);
    }
    expect(server.ran).toEqual([]);
  });

  it("drops a database a drill made (it carries the drill's mark)", async () => {
    server.answer = (_db, text) => (text.includes("shobj_description") ? MARKED : []);
    const { check } = await underKey(KEY_A);
    await expect(check.dropDrillDatabase(LIVE, "optio_drill")).resolves.toBe(true);
    expect(server.ran.at(-1)).toBe('postgres: DROP DATABASE IF EXISTS "optio_drill" WITH (FORCE)');
  });

  it("leaves a database no drill made, and says so", async () => {
    server.answer = (_db, text) => (text.includes("shobj_description") ? [{ mark: null }] : []);
    const { check } = await underKey(KEY_A);
    await expect(check.dropDrillDatabase(LIVE, "optio_staging")).rejects.toThrow(
      /wasn't made by a restore drill/,
    );
    server.answer = (_db, text) =>
      text.includes("shobj_description") ? [{ mark: "the team's scratch database" }] : [];
    await expect(check.dropDrillDatabase(LIVE, "optio_staging")).rejects.toThrow(
      /wasn't made by a restore drill/,
    );
    expect(server.ran.filter((s) => s.includes("DROP"))).toEqual([]);
  });

  it("has nothing to drop when there is no database of that name", async () => {
    const { check } = await underKey(KEY_A);
    await expect(check.dropDrillDatabase(LIVE, "optio_drill")).resolves.toBe(false);
    expect(server.ran.filter((s) => s.includes("DROP"))).toEqual([]);
  });

  it("drops from template1 when the account may not connect to postgres (as the backup job does)", async () => {
    server.answer = (db, text) => {
      if (db === "postgres") throw new Error('permission denied for database "postgres"');
      return text.includes("shobj_description") ? MARKED : [];
    };
    const { check } = await underKey(KEY_A);
    await expect(check.dropDrillDatabase(LIVE, "optio_drill")).resolves.toBe(true);
    expect(server.ran.at(-1)).toBe('template1: DROP DATABASE IF EXISTS "optio_drill" WITH (FORCE)');
  });

  it("says why when neither postgres nor template1 answers", async () => {
    server.answer = (db) => {
      throw new Error(`no pg_hba.conf entry for database "${db}"`);
    };
    const { check } = await underKey(KEY_A);
    await expect(check.dropDrillDatabase(LIVE, "optio_drill")).rejects.toThrow(
      /database "postgres"/,
    );
  });
});

describe("errorText", () => {
  it("prefers PostgreSQL's own message to drizzle's 'Failed query'", async () => {
    const { check } = await underKey(KEY_A);
    const wrapped = Object.assign(new Error("Failed query: select ..."), {
      cause: new Error('relation "secrets" does not exist'),
    });
    expect(check.errorText(wrapped)).toBe('relation "secrets" does not exist');
    expect(check.errorText(new Error("plain"))).toBe("plain");
    expect(check.errorText("text")).toBe("text");
  });
});

describe("database URLs", () => {
  it("names another database on the same server, keeping credentials and TLS", async () => {
    const { check } = await underKey(KEY_A);
    const live =
      "postgres://optio:p%40ss@optio-postgres:5432/optio?sslmode=verify-full&sslrootcert=/etc/optio/pg-ca.crt";
    expect(check.databaseOf(live)).toBe("optio");
    const drill = check.databaseUrlFor(live, "optio_drill");
    expect(check.databaseOf(drill)).toBe("optio_drill");
    expect(drill).toContain("optio:p%40ss@optio-postgres:5432/optio_drill?");
    expect(drill).toContain("sslmode=verify-full");
    expect(drill).toContain("sslrootcert=/etc/optio/pg-ca.crt");
  });

  it("refuses a database name that isn't plain", async () => {
    const { check } = await underKey(KEY_A);
    for (const bad of ['x"; DROP', "Optio", "a-b", "", "x".repeat(64)]) {
      expect(() => check.databaseUrlFor("postgres://u:p@h/optio", bad)).toThrow(
        /plain database name/,
      );
    }
  });

  it("never drops the live database", async () => {
    const { check } = await underKey(KEY_A);
    await expect(
      check.dropDrillDatabase("postgres://u:p@nowhere.invalid:5432/optio", "optio"),
    ).rejects.toThrow(/is the live database/);
    expect(server.ran).toEqual([]);
  });
});

describe("recordRestore", () => {
  it("writes an entry with no workspace and no person, naming the dump and the kept database", async () => {
    const { check } = await underKey(KEY_A);
    await check.recordRestore({
      dump: "optio-20261024T021500Z.dump",
      keptAs: "optio_before_20261024101500",
    });
    expect(logAction).toHaveBeenCalledWith({
      action: "database.restored",
      workspaceId: null,
      result: { dump: "optio-20261024T021500Z.dump", keptAs: "optio_before_20261024101500" },
      success: true,
    });
  });

  it("names only the dump when no database was kept (an in-place restore)", async () => {
    const { check } = await underKey(KEY_A);
    await check.recordRestore({ dump: "optio-20261024T021501Z-pre-upgrade.dump" });
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ result: { dump: "optio-20261024T021501Z-pre-upgrade.dump" } }),
    );
  });
});
