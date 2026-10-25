// node --test scripts/check-migrations.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkMigrations,
  findDestructive,
  markerReason,
  maskSql,
  parseReviewed,
  parseShipped,
  shippedList,
} from "./check-migrations.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "check-migrations.mjs");
const rules = (sql) => findDestructive(sql).map((f) => f.rule);
const sha = (s) => createHash("sha256").update(s).digest("hex");

describe("maskSql", () => {
  it("blanks comments and strings, keeps offsets, newlines and dollar-quoted bodies", () => {
    const sql = "SELECT 'a;b' -- DROP TABLE x;\n/* DELETE FROM y; */ DO $$ BEGIN NULL; END $$;";
    const masked = maskSql(sql);
    assert.equal(masked.length, sql.length);
    assert.equal(masked.split("\n").length, 2);
    assert.doesNotMatch(masked, /DROP|DELETE|a;b/);
    assert.match(masked, /BEGIN NULL; END/);
  });

  it("knows '' and E'\\'' inside strings, and $1 isn't a dollar quote", () => {
    const masked = maskSql("SELECT 'it''s; DROP', E'\\'; TRUNCATE', $1;");
    assert.doesNotMatch(masked, /DROP|TRUNCATE/);
    assert.equal(masked.split(";").length, 2);
  });
});

describe("findDestructive", () => {
  it("passes what is additive", () => {
    const sql = `
      -- Additive: a table, columns, indexes.
      CREATE TABLE IF NOT EXISTS "things" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" text NOT NULL,
        "owner_id" uuid REFERENCES "users"("id") ON DELETE CASCADE
      );
      ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "note" text;
      ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "tries" integer NOT NULL DEFAULT 0;
      ALTER TABLE "tasks" ADD COLUMN "seq" bigserial NOT NULL;
      ALTER TABLE "tasks" ADD CONSTRAINT "tasks_note_check" CHECK ("note" IS NOT NULL OR true);
      ALTER TABLE "model_providers" ALTER COLUMN "region" DROP NOT NULL;
      ALTER TABLE "repos" ALTER COLUMN "type" SET DEFAULT 'x';
      CREATE INDEX IF NOT EXISTS "things_name_idx" ON "things" ("name");
      ALTER TYPE "workspace_role" ADD VALUE IF NOT EXISTS 'viewer';
      UPDATE "tasks" SET "tries" = 1 WHERE "tries" IS NULL;
      DO $$ BEGIN
        CREATE TYPE "thing_state" AS ENUM ('a', 'b');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `;
    assert.deepEqual(findDestructive(sql), []);
  });

  it("flags DROP COLUMN, with its line", () => {
    const found = findDestructive('-- one\n\nALTER TABLE "tasks" DROP COLUMN "note";\n');
    assert.deepEqual(
      found.map((f) => [f.rule, f.line]),
      [["drop-column", 3]],
    );
    assert.match(found[0].sql, /ALTER TABLE "tasks" DROP COLUMN "note"/);
  });

  it("flags each destructive kind", () => {
    assert.deepEqual(rules('ALTER TABLE "t" DROP "c";'), ["drop-column"]);
    assert.deepEqual(rules('DROP TABLE IF EXISTS "old";'), ["drop-table"]);
    assert.deepEqual(rules('DROP TABLE "old" CASCADE;'), ["drop-cascade"]);
    assert.deepEqual(rules('DROP TYPE "s";'), ["drop-object"]);
    assert.deepEqual(rules('DROP INDEX IF EXISTS "i";'), ["drop-recreatable"]);
    assert.deepEqual(rules('ALTER TABLE "t" DROP CONSTRAINT "c";'), ["drop-constraint"]);
    assert.deepEqual(rules('ALTER TABLE "t" ALTER COLUMN "c" TYPE bigint;'), ["alter-type"]);
    assert.deepEqual(rules('ALTER TABLE "t" ALTER "c" SET DATA TYPE text;'), ["alter-type"]);
    assert.deepEqual(rules('ALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL;'), ["set-not-null"]);
    assert.deepEqual(rules('ALTER TABLE "t" ALTER COLUMN "c" DROP DEFAULT;'), ["drop-default"]);
    assert.deepEqual(rules('ALTER TABLE "t" ADD COLUMN "c" text NOT NULL;'), [
      "not-null-no-default",
    ]);
    assert.deepEqual(rules('ALTER TABLE "t" RENAME COLUMN "a" TO "b";'), ["rename"]);
    assert.deepEqual(rules('ALTER TABLE "t" RENAME TO "u";'), ["rename"]);
    assert.deepEqual(rules("ALTER TYPE \"s\" RENAME VALUE 'a' TO 'b';"), ["rename"]);
    assert.deepEqual(rules('ALTER INDEX "i" RENAME TO "j";'), ["rename"]);
    assert.deepEqual(rules('DELETE FROM "auth_provider_configs" WHERE "provider" = \'x\';'), [
      "delete",
    ]);
    assert.deepEqual(rules('TRUNCATE "task_logs";'), ["truncate"]);
  });

  it("finds each action of a multi-action ALTER TABLE", () => {
    assert.deepEqual(
      rules('ALTER TABLE "t" ADD COLUMN "a" text, DROP COLUMN "b", ALTER COLUMN "c" TYPE int;'),
      ["drop-column", "alter-type"],
    );
  });

  it("reads statements inside a DO block", () => {
    assert.deepEqual(
      rules(
        'DO $$ BEGIN\n  ALTER TABLE "t" DROP COLUMN "c";\nEXCEPTION WHEN others THEN null;\nEND $$;',
      ),
      ["drop-column"],
    );
  });

  it("allows what the same file makes again or made itself", () => {
    // Re-made: an index, a constraint, a view.
    assert.deepEqual(
      rules(`
        DROP INDEX IF EXISTS "i";
        CREATE INDEX IF NOT EXISTS "i" ON "t" ("a", "b");
        ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "c";
        ALTER TABLE "t" ADD CONSTRAINT "c" CHECK ("a" > 0);
        DROP VIEW IF EXISTS "v";
        CREATE VIEW "v" AS SELECT 1;
      `),
      [],
    );
    // A table this file made earlier: a scratch table.
    assert.deepEqual(
      rules(`
        CREATE TEMP TABLE "scratch" ("id" uuid NOT NULL);
        ALTER TABLE "scratch" ADD COLUMN "n" int NOT NULL;
        DELETE FROM "scratch";
        DROP TABLE "scratch";
      `),
      [],
    );
    // A column this file adds, then changes.
    assert.deepEqual(
      rules(`
        ALTER TABLE "repos" ADD COLUMN "review_depth" text DEFAULT 'x';
        ALTER TABLE "repos" ALTER COLUMN "review_depth" DROP DEFAULT;
      `),
      [],
    );
    // Several scratch tables, indexes or functions the file made, dropped at once.
    assert.deepEqual(
      rules(`
        CREATE TEMP TABLE a (id int);
        CREATE TEMP TABLE "b" (id int);
        CREATE INDEX i1 ON t (x);
        CREATE INDEX i2 ON t (y);
        CREATE FUNCTION f(int) RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;
        CREATE FUNCTION g(text) RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;
        DROP TABLE a, "b";
        DROP INDEX i1, i2;
        DROP FUNCTION f(int), g(text);
        CREATE INDEX i1 ON t (x);
        CREATE INDEX i2 ON t (y);
        CREATE FUNCTION f(int) RETURNS int AS $$ SELECT 2 $$ LANGUAGE sql;
        CREATE FUNCTION g(text) RETURNS int AS $$ SELECT 2 $$ LANGUAGE sql;
      `),
      [],
    );
  });

  it("judges every name a DROP lists, not only the first", () => {
    assert.deepEqual(rules("CREATE TABLE tmp (id int); DROP TABLE tmp, tasks;"), ["drop-table"]);
    assert.deepEqual(
      rules('CREATE TABLE tmp (id int); DROP TABLE IF EXISTS "tmp", public.tasks;'),
      ["drop-table"],
    );
    assert.deepEqual(rules("CREATE INDEX a ON t(x); DROP INDEX a, b;"), ["drop-recreatable"]);
    assert.deepEqual(
      rules(
        "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql; DROP FUNCTION f(), g(text);",
      ),
      ["drop-recreatable"],
    );
  });

  it("doesn't take IF NOT EXISTS as made here: it may find the live table or column", () => {
    for (const [sql, rule] of [
      [
        "CREATE TABLE IF NOT EXISTS tasks (id int); ALTER TABLE tasks DROP COLUMN title;",
        "drop-column",
      ],
      ["CREATE TABLE IF NOT EXISTS tasks (id int); DELETE FROM tasks;", "delete"],
      ["CREATE TABLE IF NOT EXISTS tasks (id int); DROP TABLE tasks;", "drop-table"],
      [
        "CREATE TABLE IF NOT EXISTS tasks (id int); ALTER TABLE tasks ALTER COLUMN title TYPE int;",
        "alter-type",
      ],
      [
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS title text; ALTER TABLE tasks DROP COLUMN title;",
        "drop-column",
      ],
      [
        'ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "review_depth" text;\nALTER TABLE "repos" ALTER COLUMN "review_depth" DROP DEFAULT;',
        "drop-default",
      ],
    ]) {
      assert.deepEqual(rules(sql), [rule], sql);
    }
    // Nor is the word COLUMN a column the file added ("column" quoted would be).
    assert.deepEqual(
      rules('ALTER TABLE t ADD COLUMN IF NOT EXISTS x text;\nALTER TABLE t DROP COLUMN "column";'),
      ["drop-column"],
    );
    // On its own, IF NOT EXISTS is additive.
    assert.deepEqual(
      rules(
        'CREATE TABLE IF NOT EXISTS "n" ("id" int);\nALTER TABLE "n" ADD COLUMN IF NOT EXISTS "x" text;',
      ),
      [],
    );
  });

  it("still flags a table dropped and made again (its rows are gone)", () => {
    assert.deepEqual(rules('DROP TABLE IF EXISTS "t";\nCREATE TABLE "t" ("id" int);'), [
      "drop-table",
    ]);
  });

  it("ignores words in comments, strings and names", () => {
    assert.deepEqual(
      rules(`
        -- We never DROP TABLE here, nor DELETE FROM anything.
        COMMENT ON TABLE "t" IS 'TRUNCATE is not run';
        ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "drop_at" timestamptz;
        ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "deleted" boolean DEFAULT false NOT NULL;
      `),
      [],
    );
  });
});

describe("markerReason", () => {
  it("reads the marker's reason", () => {
    assert.equal(
      markerReason(
        "-- optio:allow-destructive the column was never written\nALTER TABLE t DROP c;",
      ),
      "the column was never written",
    );
    assert.equal(markerReason("-- optio:allow-destructive\n"), "");
    assert.equal(markerReason("SELECT 1;"), null);
  });
});

describe("checkMigrations", () => {
  let dir;
  const write = (name, sql) => writeFileSync(join(dir, name), sql);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "check-migrations-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("fails a new migration with DROP COLUMN, and passes it with the marker", () => {
    write("1800000000_drop.sql", 'ALTER TABLE "tasks" DROP COLUMN "note";\n');
    let r = checkMigrations({ dir, shipped: new Map() });
    assert.equal(r.checked, 1);
    assert.deepEqual(
      r.problems.map((p) => [p.file, p.rule, p.line]),
      [["1800000000_drop.sql", "drop-column", 1]],
    );

    write(
      "1800000000_drop.sql",
      '-- optio:allow-destructive nothing read "note" since 0.18; back it up first\nALTER TABLE "tasks" DROP COLUMN "note";\n',
    );
    r = checkMigrations({ dir, shipped: new Map() });
    assert.deepEqual(r.problems, []);
    assert.deepEqual(
      r.allowed.map((p) => [p.rule, p.reason]),
      [["drop-column", 'nothing read "note" since 0.18; back it up first']],
    );
  });

  it("wants a reason on the marker", () => {
    write("1800000000_drop.sql", '-- optio:allow-destructive ok\nALTER TABLE "t" DROP "c";\n');
    const r = checkMigrations({ dir, shipped: new Map() });
    assert.deepEqual(r.problems.map((p) => p.rule).sort(), [
      "drop-column",
      "marker-without-reason",
    ]);
  });

  it("leaves shipped files alone, and fails one that changed or went away", () => {
    const old = 'DELETE FROM "auth_provider_configs";\n';
    write("0001_old.sql", old);
    write("0002_kept.sql", "SELECT 1;\n");
    let shipped = parseShipped(shippedList(dir));
    assert.deepEqual(checkMigrations({ dir, shipped }).problems, []);
    assert.equal(checkMigrations({ dir, shipped }).checked, 0);

    write("0002_kept.sql", "SELECT 2;\n");
    rmSync(join(dir, "0001_old.sql"));
    const r = checkMigrations({ dir, shipped });
    assert.deepEqual(r.problems.map((p) => [p.file, p.rule]).sort(), [
      ["0001_old.sql", "removed-after-shipping"],
      ["0002_kept.sql", "changed-after-shipping"],
    ]);
    shipped = parseShipped(shippedList(dir));
    assert.deepEqual(checkMigrations({ dir, shipped }).problems, []);
  });

  it("takes a reviewed file while its hash matches", () => {
    const sql = 'DROP TABLE "legacy";\n';
    write("1800000100_upstream.sql", sql);
    const reviewed = parseReviewed(
      `# comment\n1800000100_upstream.sql ${sha(sql)} upstream drops a table nothing reads\n`,
    );
    let r = checkMigrations({ dir, shipped: new Map(), reviewed });
    assert.deepEqual(r.problems, []);
    assert.equal(r.allowed[0].reason, "upstream drops a table nothing reads");

    write("1800000100_upstream.sql", `${sql}DROP TABLE "other";\n`);
    r = checkMigrations({ dir, shipped: new Map(), reviewed });
    assert.deepEqual(
      r.problems.map((p) => p.rule),
      ["drop-table", "drop-table"],
    );
  });
});

describe("the command", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "check-migrations-cli-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => {
    try {
      return {
        status: 0,
        out: execFileSync("node", [SCRIPT, ...args], { encoding: "utf8", stdio: "pipe" }),
      };
    } catch (err) {
      return { status: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };

  it("exits 1 and names the file, line and rule", () => {
    const migrations = join(dir, "migrations");
    execFileSync("mkdir", ["-p", migrations]);
    writeFileSync(join(migrations, "1800000000_ok.sql"), 'CREATE TABLE "a" ("id" int);\n');
    writeFileSync(join(migrations, "1800000100_bad.sql"), '\nALTER TABLE "a" RENAME TO "b";\n');
    writeFileSync(join(dir, "shipped.txt"), "");
    const r = run(
      "--dir",
      migrations,
      "--shipped",
      join(dir, "shipped.txt"),
      "--reviewed",
      join(dir, "none"),
    );
    assert.equal(r.status, 1);
    assert.match(r.out, /ERROR {4}1800000100_bad\.sql:2: rename — ALTER TABLE "a" RENAME TO "b"/);
    assert.match(r.out, /-- optio:allow-destructive/);
  });

  it("--record writes the list sha256sum would, under its header", () => {
    const migrations = join(dir, "m");
    execFileSync("mkdir", ["-p", migrations]);
    writeFileSync(join(migrations, "0002_b.sql"), "SELECT 2;\n");
    writeFileSync(join(migrations, "0001_a.sql"), "SELECT 1;\n");
    const list = join(dir, "shipped.txt");
    assert.equal(run("--dir", migrations, "--shipped", list, "--record").status, 0);
    const lines = readFileSync(list, "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"));
    assert.deepEqual(lines, [
      `${sha("SELECT 1;\n")}  0001_a.sql`,
      `${sha("SELECT 2;\n")}  0002_b.sql`,
    ]);
    assert.equal(run("--dir", migrations, "--shipped", list).status, 0);
  });

  it("--verify-recorded: passes on the list --record wrote, names each migration it doesn't record", () => {
    const migrations = join(dir, "m");
    execFileSync("mkdir", ["-p", migrations]);
    writeFileSync(join(migrations, "0001_a.sql"), "SELECT 1;\n");
    writeFileSync(join(migrations, "0002_b.sql"), "SELECT 2;\n");
    const list = join(dir, "shipped.txt");
    const verify = () => run("--dir", migrations, "--shipped", list, "--verify-recorded");
    assert.equal(verify().status, 2, "no list yet");
    assert.equal(run("--dir", migrations, "--shipped", list, "--record").status, 0);
    const ok = verify();
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /recorded as shipped: all 2/);
    // Merged after the bump: a new one, one changed, one gone.
    writeFileSync(join(migrations, "0003_c.sql"), "SELECT 3;\n");
    writeFileSync(join(migrations, "0002_b.sql"), "SELECT 22;\n");
    rmSync(join(migrations, "0001_a.sql"));
    const r = verify();
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /0003_c\.sql: not recorded as shipped/);
    assert.match(r.out, /0002_b\.sql: changed since it was recorded/);
    assert.match(r.out, /0001_a\.sql: recorded as shipped, but gone/);
    assert.match(r.out, /--record again/);
  });

  it("can compare against this repository's current revision", () => {
    const r = run("--base", "HEAD");
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Migrations stay additive/);
  });
});
