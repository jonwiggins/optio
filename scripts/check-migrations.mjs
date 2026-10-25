#!/usr/bin/env node
// Migrations stay additive (docs/backup.md, "Migrations stay
// additive"). A migration that drops, renames, retypes or deletes breaks the
// version before it, which still runs during a rollout and after a rollback,
// and loses data no rollback brings back. This check reads every migration a
// release hasn't shipped yet and fails on:
//
//   drop-table        DROP TABLE, each table it names (one this file made earlier is fine)
//   drop-object       DROP SCHEMA / TYPE / DOMAIN / SEQUENCE / MATERIALIZED VIEW /
//                     EXTENSION / DATABASE / OWNED / ROLE / USER
//   drop-recreatable  DROP INDEX / VIEW / FUNCTION / PROCEDURE / TRIGGER / POLICY /
//                     RULE that the same file doesn't make again
//   drop-cascade      any DROP ... CASCADE (it takes dependent objects with it)
//   drop-column       ALTER TABLE ... DROP [COLUMN]
//   drop-constraint   ALTER TABLE ... DROP CONSTRAINT the file doesn't add again
//   drop-default      ALTER COLUMN ... DROP DEFAULT / IDENTITY / EXPRESSION
//   alter-type        ALTER COLUMN ... [SET DATA] TYPE
//   set-not-null      ALTER COLUMN ... SET NOT NULL
//   not-null-no-default  ADD COLUMN ... NOT NULL without a DEFAULT
//   rename            RENAME (a table, column, constraint, type value, …), SET SCHEMA
//   drop-attribute    ALTER TYPE ... DROP ATTRIBUTE
//   delete            DELETE FROM (a table this file made earlier is fine)
//   truncate          TRUNCATE
//
// Not flagged: new tables, columns that are nullable or have a default, new
// indexes and constraints, DROP NOT NULL (old code still writes the column),
// UPDATE (a backfill), and ALTER on a table or a column the same file creates.
// "Creates" means a plain CREATE TABLE or ADD COLUMN: one with IF NOT EXISTS
// may find the live table or column and do nothing, so what the file does to
// it after counts as done to the live one. SQL inside string literals
// (EXECUTE '…') isn't read: review dynamic SQL by hand.
//
// By default compare with origin/main (or OPTIO_MIGRATION_BASE). Existing
// migrations must keep their hashes; only new files are checked for SQL safety.
// Dynamic SQL still needs manual review. A deliberate exception must explain
// itself with -- optio:allow-destructive <reason> (at least 10 characters).
//
//   node scripts/check-migrations.mjs [options] [file.sql ...]
//     --base <ref>         migration baseline (default origin/main)
//     --dir <dir>          default apps/api/src/db/migrations
//     --shipped <file>     use a sha256sum baseline instead of git
//     --reviewed <file>    optional <filename> <sha256> <reason> exceptions
//     --all                inspect every migration as new
//     --record             write a baseline to --shipped and stop
//     --verify-recorded    verify every migration against --shipped
//   Files named on the command line are checked as new, alone.
//   Exit status: 0 clean, 1 findings, 2 usage.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MARKER = "optio:allow-destructive";
const MIN_REASON = 10;

/** What each rule means, and what to do instead: printed under a finding. */
export const RULES = {
  "drop-table": "drops a table and its rows",
  "drop-object": "drops an object the running version may still use",
  "drop-recreatable": "drops an object the file doesn't make again",
  "drop-cascade": "CASCADE also drops whatever depends on it (columns, views, triggers)",
  "drop-column": "drops a column the version before this one still reads and writes",
  "drop-constraint": "drops a constraint the file doesn't add again",
  "drop-default": "the version before this one may insert without the column",
  "alter-type": "retypes a column: the version before this one may write the old type",
  "set-not-null": "existing rows with NULL fail it, and older code may still write NULL",
  "not-null-no-default": "fails on a table with rows, and older code inserts without it",
  rename: "the version before this one still uses the old name",
  "drop-attribute": "drops a composite type's attribute",
  delete: "deletes rows no rollback brings back",
  truncate: "empties a table",
};

// ── Reading SQL ───────────────────────────────────────────────────────────

/**
 * The SQL with comments and string literals blanked out (newlines kept, so
 * offsets and line numbers stay the source's). Dollar-quote delimiters are
 * blanked too, but their bodies stay: a DO block's statements run.
 */
export function maskSql(sql) {
  const out = sql.split("");
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      blank(i, j);
      i = j;
    } else if (c === "'") {
      // E'…' strings take backslash escapes; '' is a quote in both kinds.
      const escapes = i > 0 && /[eE]/.test(sql[i - 1]) && !/[\w$]/.test(sql[i - 2] ?? "");
      let j = i + 1;
      while (j < n) {
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      blank(i, Math.min(j + 1, n));
      i = j + 1;
    } else if (c === '"') {
      // A quoted identifier: kept (names matter), but never a statement end.
      let j = i + 1;
      while (j < n && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      for (let k = i; k <= j && k < n; k++) if (out[k] === ";") out[k] = " ";
      i = j + 1;
    } else if (c === "$" && !/[\w$]/.test(sql[i - 1] ?? "")) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        blank(i, i + m[0].length);
        i += m[0].length;
      } else i++;
    } else i++;
  }
  return out.join("");
}

/** Statements (split at `;`) with their offset in the source. */
export function statements(masked) {
  const list = [];
  let start = 0;
  for (let i = 0; i <= masked.length; i++) {
    if (i === masked.length || masked[i] === ";") {
      const text = masked.slice(start, i);
      if (text.trim()) list.push({ text, offset: start + (text.length - text.trimStart().length) });
      start = i + 1;
    }
  }
  return list;
}

const NAME = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*))?`;
/** The names a DROP lists: name [(args)] [, name [(args)] ...]. */
const DROP_LIST = String.raw`${NAME}(?:\s*\([^()]*\))?(?:\s*,\s*${NAME}(?:\s*\([^()]*\))?)*`;

/** A name as one key: unquoted, lower case, without its schema. */
export function nameKey(raw) {
  const parts = raw.split(/\s*\.\s*(?=(?:"|[A-Za-z_]))/);
  const last = parts[parts.length - 1].trim();
  return last.startsWith('"') ? last.slice(1, -1).replace(/""/g, '"') : last.toLowerCase();
}

/** Split an ALTER TABLE action list at the commas outside parentheses. */
function splitActions(text) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) {
      parts.push({ text: text.slice(from, i), at: from });
      from = i + 1;
    }
  }
  parts.push({ text: text.slice(from), at: from });
  return parts.filter((p) => p.text.trim());
}

const RECREATABLE = ["INDEX", "VIEW", "FUNCTION", "PROCEDURE", "TRIGGER", "POLICY", "RULE"];

/** What a file creates: kind → name → statement indexes. */
function created(stmts) {
  const made = new Map();
  const add = (kind, name, idx) => {
    if (!made.has(kind)) made.set(kind, new Map());
    const byName = made.get(kind);
    const key = nameKey(name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(idx);
  };
  const patterns = [
    // Not CREATE TABLE IF NOT EXISTS: on a database that has the table it does
    // nothing, and what the file does to "its" table then hits the live one.
    [
      "TABLE",
      new RegExp(
        String.raw`\bCREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+(?!IF\s+NOT\s+EXISTS\b)(${NAME})`,
        "gi",
      ),
    ],
    [
      "INDEX",
      new RegExp(
        String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!ON\b)(${NAME})`,
        "gi",
      ),
    ],
    [
      "VIEW",
      new RegExp(
        String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP|TEMPORARY|RECURSIVE)\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(${NAME})`,
        "gi",
      ),
    ],
    ["FUNCTION", new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(${NAME})`, "gi")],
    [
      "PROCEDURE",
      new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+(${NAME})`, "gi"),
    ],
    [
      "TRIGGER",
      new RegExp(
        String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+(${NAME})`,
        "gi",
      ),
    ],
    ["POLICY", new RegExp(String.raw`\bCREATE\s+POLICY\s+(${NAME})`, "gi")],
    ["RULE", new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?RULE\s+(${NAME})`, "gi")],
    ["CONSTRAINT", new RegExp(String.raw`\bADD\s+CONSTRAINT\s+(${NAME})`, "gi")],
  ];
  stmts.forEach((s, idx) => {
    for (const [kind, re] of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s.text))) add(kind, m[1], idx);
    }
  });
  return made;
}

const madeAt = (made, kind, name) => made.get(kind)?.get(nameKey(name)) ?? [];

/** Each destructive statement: { rule, line, offset, sql }. */
export function findDestructive(sql) {
  const masked = maskSql(sql);
  const stmts = statements(masked);
  const made = created(stmts);
  const findings = [];
  const lineAt = (offset) => sql.slice(0, offset).split("\n").length;
  const excerpt = (text) => text.replace(/\s+/g, " ").trim().slice(0, 160);
  const flag = (rule, s, at = 0) =>
    findings.push({
      rule,
      line: lineAt(s.offset + at),
      offset: s.offset + at,
      sql: excerpt(s.text),
    });
  const tableMadeBefore = (name, idx) => madeAt(made, "TABLE", name).some((j) => j < idx);
  const madeElsewhere = (kind, name, idx) => madeAt(made, kind, name).some((j) => j !== idx);
  // Columns this file adds (table.column → first statement): changing one
  // later in the same file changes nothing a running version knows. Not
  // ADD COLUMN IF NOT EXISTS: on a database that has the column it does
  // nothing, and the change then hits the live column.
  const added = new Map();
  const columnKey = (table, column) => `${nameKey(table)}.${nameKey(column)}`;
  const alterTable = new RegExp(
    String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${NAME})\s*\*?\s*([\s\S]*)$`,
    "i",
  );
  stmts.forEach((s, idx) => {
    const table = alterTable.exec(s.text);
    if (!table) return;
    for (const action of splitActions(table[2])) {
      const c = new RegExp(
        String.raw`^\s*ADD\s+(?:COLUMN\s+)?(?!IF\s+NOT\s+EXISTS\b)(?!(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE|COLUMN)\b)(${NAME})`,
        "i",
      ).exec(action.text);
      if (c && !added.has(columnKey(table[1], c[1]))) added.set(columnKey(table[1], c[1]), idx);
    }
  });
  const addedBefore = (table, column, idx) => (added.get(columnKey(table, column)) ?? idx) < idx;

  stmts.forEach((s, idx) => {
    const t = s.text;
    let m;

    // DROP <object> [, <object> ...]: each name is judged (DROP TABLE tmp, tasks
    // drops tasks too, whatever tmp is).
    const drop = new RegExp(
      String.raw`\bDROP\s+(TABLE|SCHEMA|TYPE|DOMAIN|SEQUENCE|MATERIALIZED\s+VIEW|EXTENSION|DATABASE|OWNED|ROLE|USER|INDEX|VIEW|FUNCTION|PROCEDURE|TRIGGER|POLICY|RULE|AGGREGATE|CAST|OPERATOR|COLLATION|SERVER|PUBLICATION|SUBSCRIPTION)\b(?:\s+CONCURRENTLY)?(?:\s+IF\s+EXISTS)?\s*(${DROP_LIST})?`,
      "gi",
    );
    while ((m = drop.exec(t))) {
      const kind = m[1].toUpperCase().replace(/\s+/g, " ");
      // The names, without a function's argument list.
      const names = [
        ...(m[2] ?? "").replace(/\([^()]*\)/g, " ").matchAll(new RegExp(NAME, "g")),
      ].map((n) => n[0]);
      if (/\bCASCADE\b/i.test(t.slice(m.index))) {
        flag("drop-cascade", s, m.index);
      } else if (kind === "TABLE") {
        if (!names.length || names.some((n) => !tableMadeBefore(n, idx))) {
          flag("drop-table", s, m.index);
        }
      } else if (RECREATABLE.includes(kind)) {
        if (!names.length || names.some((n) => !madeElsewhere(kind, n, idx))) {
          flag("drop-recreatable", s, m.index);
        }
      } else {
        flag("drop-object", s, m.index);
      }
    }

    // ALTER TABLE <name> <actions>
    m = alterTable.exec(t);
    if (m && !tableMadeBefore(m[1], idx)) {
      const actionsAt = m.index + m[0].length - m[2].length;
      for (const action of splitActions(m[2])) {
        const a = action.text;
        const at = actionsAt + action.at + (a.length - a.trimStart().length);
        // Keywords only: quoted names can't pass for one ("type", "default").
        const word = a
          .replace(/"(?:[^"]|"")*"/g, '"x"')
          .trim()
          .toUpperCase();
        const column = new RegExp(
          String.raw`^\s*ALTER\s+(?:COLUMN\s+)?(${NAME})\s+([\s\S]*)$`,
          "i",
        ).exec(a);
        const dropped = new RegExp(
          String.raw`^\s*DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(${NAME})`,
          "i",
        ).exec(a);
        if (/^RENAME\b/.test(word) || /^SET\s+SCHEMA\b/.test(word)) {
          flag("rename", s, at);
        } else if (/^DROP\s+CONSTRAINT\b/.test(word)) {
          const c = new RegExp(
            String.raw`^\s*DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(${NAME})`,
            "i",
          ).exec(a);
          if (/\bCASCADE\b/.test(word)) flag("drop-cascade", s, at);
          else if (!c || !madeElsewhere("CONSTRAINT", c[1], idx)) flag("drop-constraint", s, at);
        } else if (/^DROP\b/.test(word)) {
          if (/\bCASCADE\b/.test(word)) flag("drop-cascade", s, at);
          else if (!dropped || !addedBefore(m[1], dropped[1], idx)) flag("drop-column", s, at);
        } else if (column && !addedBefore(m[1], column[1], idx)) {
          const rest = column[2].replace(/"(?:[^"]|"")*"/g, '"x"').toUpperCase();
          if (/^(?:SET\s+DATA\s+)?TYPE\b/.test(rest)) flag("alter-type", s, at);
          else if (/^SET\s+NOT\s+NULL\b/.test(rest)) flag("set-not-null", s, at);
          else if (/^DROP\s+(?:DEFAULT|IDENTITY|EXPRESSION)\b/.test(rest)) {
            flag("drop-default", s, at);
          }
        } else if (
          /^ADD\b/.test(word) &&
          !/^ADD\s+(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\b/.test(word)
        ) {
          const notNull = /(?<!\bIS\s+)\bNOT\s+NULL\b/.test(word) || /\bPRIMARY\s+KEY\b/.test(word);
          const filled = /\bDEFAULT\b|\bGENERATED\b|\b(?:SMALL|BIG)?SERIAL\d?\b/.test(word);
          if (notNull && !filled) flag("not-null-no-default", s, at);
        }
      }
    }

    // ALTER <anything else> … RENAME / SET SCHEMA; ALTER TYPE … DROP ATTRIBUTE
    if (!m) {
      const other =
        /\bALTER\s+(?!TABLE\b)(?:MATERIALIZED\s+VIEW|[A-Z]+)\b[\s\S]*?\b(RENAME|SET\s+SCHEMA|DROP\s+ATTRIBUTE)\b/i.exec(
          t,
        );
      if (other && !/\bALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(t)) {
        flag(/^DROP/i.test(other[1]) ? "drop-attribute" : "rename", s, other.index);
      }
    }

    // DELETE FROM <name>, TRUNCATE
    const del = new RegExp(String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?(${NAME})`, "gi");
    while ((m = del.exec(t))) if (!tableMadeBefore(m[1], idx)) flag("delete", s, m.index);
    const trunc = /\bTRUNCATE\b/gi;
    while ((m = trunc.exec(t))) flag("truncate", s, m.index);
  });
  findings.sort((a, b) => a.offset - b.offset);
  return findings;
}

/** The marker's reason, "" when it has none, null when there is no marker. */
export function markerReason(sql) {
  const m = new RegExp(String.raw`--\s*${MARKER}\b[ \t]*(.*)$`, "m").exec(sql);
  return m ? m[1].trim() : null;
}

// ── The lists ─────────────────────────────────────────────────────────────

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** sha256sum lines → Map(file name → hash). */
export function parseShipped(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(l);
    if (m) map.set(basename(m[2].trim()), m[1]);
  }
  return map;
}

/** `<file> <sha256> <reason>` lines → Map(file name → { hash, reason }). */
export function parseReviewed(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    const m = /^(\S+)\s+([0-9a-f]{64})\s+(.+)$/.exec(l);
    if (m) map.set(basename(m[1]), { hash: m[2], reason: m[3].trim() });
  }
  return map;
}

export const SHIPPED_HEADER = [
  "# The migrations releases shipped, as sha256sum lists them. Written by",
  "# scripts/build-release.sh --bump (check-migrations.mjs --record);",
  "# check-migrations.mjs reads every migration not listed here, and fails when",
  "# a listed one changed or went away. Don't edit by hand.",
].join("\n");

/** The shipped list for every *.sql in dir: the header, then sha256sum lines by name. */
export function shippedList(dir) {
  const lines = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((f) => `${sha256(readFileSync(join(dir, f)))}  ${f}\n`)
    .join("");
  return `${SHIPPED_HEADER}\n${lines}`;
}

/**
 * Where the shipped list and the migrations in dir differ (what --record would
 * change): [{ file, why }], by file name.
 */
export function unrecorded(dir, shipped) {
  const present = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out = [];
  for (const file of present) {
    const recorded = shipped.get(file);
    if (!recorded) out.push({ file, why: "not recorded as shipped" });
    else if (recorded !== sha256(readFileSync(join(dir, file)))) {
      out.push({ file, why: "changed since it was recorded" });
    }
  }
  for (const file of shipped.keys()) {
    if (!present.includes(file)) out.push({ file, why: "recorded as shipped, but gone" });
  }
  return out;
}

/**
 * Check a migrations directory against the shipped and reviewed lists.
 * Returns { checked, problems: [{ file, rule, line?, sql?, detail }], allowed: [...] }.
 */
export function checkMigrations({ dir, shipped, reviewed = new Map(), only = null, all = false }) {
  const problems = [];
  const allowed = [];
  const present = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  const files = only ?? present;
  let checked = 0;
  for (const file of files) {
    const path = only ? file : join(dir, file);
    const name = basename(path);
    const buf = readFileSync(path);
    const hash = sha256(buf);
    const review = reviewed.get(name);
    const reviewedNow = review && review.hash === hash;
    const shippedHash = !only && !all ? shipped.get(name) : undefined;
    if (shippedHash === hash) continue;
    if (shippedHash) {
      const p = {
        file: name,
        rule: "changed-after-shipping",
        detail:
          "shipped in a release, then changed: db/migrate-safe.ts applies a migration by its hash, so every database runs it again. Put the change in a new migration",
      };
      if (reviewedNow) allowed.push({ ...p, reason: review.reason });
      else problems.push(p);
      continue;
    }
    checked++;
    const sql = buf.toString("utf8");
    const found = findDestructive(sql);
    if (!found.length) continue;
    const reason = markerReason(sql);
    for (const f of found) {
      const p = { file: name, ...f, detail: RULES[f.rule] };
      if (reviewedNow) allowed.push({ ...p, reason: review.reason });
      else if (reason && reason.length >= MIN_REASON) allowed.push({ ...p, reason });
      else problems.push(p);
    }
    if (reason !== null && reason.length < MIN_REASON && !reviewedNow) {
      problems.push({
        file: name,
        rule: "marker-without-reason",
        detail: `the ${MARKER} marker needs its reason (at least ${MIN_REASON} characters)`,
      });
    }
  }
  if (!only && !all) {
    for (const name of shipped.keys()) {
      if (present.includes(name)) continue;
      const p = {
        file: name,
        rule: "removed-after-shipping",
        detail:
          "shipped in a release, then removed: databases keep what it made, new installs never get it",
      };
      if (reviewed.has(name)) allowed.push({ ...p, reason: reviewed.get(name).reason });
      else problems.push(p);
    }
  }
  return { checked, problems, allowed };
}

export function migrationsAtRef(dir, base) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
  const rel = relative(root, dir).split("\\").join("/");
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", base, "--", rel], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter((f) => f.endsWith(".sql"));
  return new Map(
    files.map((f) => [
      basename(f),
      createHash("sha256")
        .update(execFileSync("git", ["show", `${base}:${f}`], { cwd: root }))
        .digest("hex"),
    ]),
  );
}

// ── The command ───────────────────────────────────────────────────────────

function usage(code) {
  const text = readFileSync(fileURLToPath(import.meta.url), "utf8")
    .split("\n")
    .slice(1)
    .filter((l, i, a) => a.slice(0, i + 1).every((x) => x.startsWith("//")))
    .map((l) => l.replace(/^\/\/ ?/, ""))
    .join("\n");
  (code ? process.stderr : process.stdout).write(`${text}\n`);
  process.exit(code);
}

export function main(argv) {
  let dir = join(ROOT, "apps/api/src/db/migrations");
  let shippedFile = "";
  let base = process.env.OPTIO_MIGRATION_BASE || "origin/main";
  let reviewedFile = "";
  let all = false;
  let record = false;
  let verifyRecorded = false;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) usage(2);
      return argv[++i];
    };
    if (a === "--base") base = value();
    else if (a === "--dir") dir = resolve(value());
    else if (a === "--shipped") shippedFile = resolve(value());
    else if (a === "--reviewed") reviewedFile = resolve(value());
    else if (a === "--all") all = true;
    else if (a === "--record") record = true;
    else if (a === "--verify-recorded") verifyRecorded = true;
    else if (a === "-h" || a === "--help") usage(0);
    else if (a.startsWith("-")) {
      process.stderr.write(`Unknown option: ${a}\n`);
      usage(2);
    } else files.push(resolve(a));
  }
  if (!existsSync(dir)) {
    process.stderr.write(`No migrations directory: ${dir}\n`);
    return 2;
  }
  if ((record || verifyRecorded) && !shippedFile) {
    process.stderr.write("--record / --verify-recorded requires --shipped <file>\n");
    return 2;
  }
  if (record) {
    writeFileSync(shippedFile, shippedList(dir));
    process.stdout.write(`${relative(process.cwd(), shippedFile) || shippedFile}: written\n`);
    return 0;
  }
  if (verifyRecorded) {
    if (!existsSync(shippedFile)) {
      process.stderr.write(`No ${shippedFile}: --record writes it\n`);
      return 2;
    }
    const diff = unrecorded(dir, parseShipped(readFileSync(shippedFile, "utf8")));
    for (const d of diff) process.stderr.write(`ERROR    ${d.file}: ${d.why}\n`);
    if (diff.length) {
      process.stderr.write(
        `\n${relative(process.cwd(), shippedFile) || shippedFile} doesn't record the migrations this source ships ` +
          `(${diff.length} difference(s)): run --record again, ` +
          `commit what it writes, and build again.\n`,
      );
      return 1;
    }
    process.stdout.write(
      `Migrations recorded as shipped: all ${readdirSync(dir).filter((f) => f.endsWith(".sql")).length}, as they are.\n`,
    );
    return 0;
  }
  if (shippedFile && !existsSync(shippedFile) && !all && !files.length) {
    process.stderr.write(`No migration inventory: ${shippedFile}\n`);
    return 2;
  }
  let shipped = existsSync(shippedFile)
    ? parseShipped(readFileSync(shippedFile, "utf8"))
    : new Map();
  if (!files.length && !all && !shippedFile) {
    try {
      shipped = migrationsAtRef(dir, base);
    } catch (err) {
      process.stderr.write(
        `Cannot read migration baseline ${base}: ${err.message}\nUse --base <git ref>, --shipped <file>, or name individual SQL files.\n`,
      );
      return 2;
    }
  }
  const reviewed = existsSync(reviewedFile)
    ? parseReviewed(readFileSync(reviewedFile, "utf8"))
    : new Map();
  const { checked, problems, allowed } = checkMigrations({
    dir,
    shipped,
    reviewed,
    all,
    only: files.length ? files : null,
  });
  const where = (p) => `${p.file}${p.line ? `:${p.line}` : ""}`;
  for (const p of allowed) {
    process.stdout.write(`allowed  ${where(p)}: ${p.rule}${p.sql ? ` — ${p.sql}` : ""}\n`);
    process.stdout.write(`         reason: ${p.reason}\n`);
  }
  for (const p of problems) {
    process.stderr.write(`ERROR    ${where(p)}: ${p.rule}${p.sql ? ` — ${p.sql}` : ""}\n`);
    process.stderr.write(`         ${p.detail}\n`);
  }
  const scope = files.length
    ? `${checked} file(s)`
    : all
      ? `${checked} migration(s)`
      : `${checked} migration(s) not shipped yet`;
  if (problems.length) {
    process.stderr.write(
      `\n${problems.length} problem(s) in ${scope}. Migrations stay additive (docs/backup.md): ` +
        `add instead of changing, or mark a reviewed exception in the file with\n` +
        `  -- ${MARKER} <why it is safe, and what an operator does first>\n`,
    );
    return 1;
  }
  process.stdout.write(
    `Migrations stay additive: ${scope} checked${allowed.length ? `, ${allowed.length} reviewed exception(s)` : ""}.\n`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main(process.argv.slice(2));
}
