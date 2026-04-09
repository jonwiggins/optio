import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dirname);
const JOURNAL_PATH = join(MIGRATIONS_DIR, "meta", "_journal.json");

// These duplicate-prefix SQL files are intentionally absent from the journal.
// Their DDL is covered by the repair migration (1775613995_repair_duplicate_migrations.sql).
const REPAIR_SUPERSEDED_FILES = new Set([
  "0016_notification_webhooks.sql",
  "0018_interactive_sessions.sql",
  "0019_task_comments_activity.sql",
  "0026_pod_resource_requests.sql",
]);

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

function readJournal(): Journal {
  return JSON.parse(readFileSync(JOURNAL_PATH, "utf-8"));
}

function listMigrationSqlFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
}

describe("migration journal consistency", () => {
  it("every .sql migration file has an entry in _journal.json", () => {
    const journal = readJournal();
    const journalTags = new Set(journal.entries.map((e) => e.tag));
    const sqlFiles = listMigrationSqlFiles();

    const missing: string[] = [];
    for (const file of sqlFiles) {
      if (REPAIR_SUPERSEDED_FILES.has(file)) continue;
      const tag = file.replace(/\.sql$/, "");
      if (!journalTags.has(tag)) {
        missing.push(file);
      }
    }

    expect(missing, `Migration files missing from _journal.json: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("every _journal.json entry has a corresponding .sql file", () => {
    const journal = readJournal();
    const sqlFiles = new Set(listMigrationSqlFiles().map((f) => f.replace(/\.sql$/, "")));

    const orphaned: string[] = [];
    for (const entry of journal.entries) {
      if (!sqlFiles.has(entry.tag)) {
        orphaned.push(entry.tag);
      }
    }

    expect(
      orphaned,
      `Journal entries without corresponding .sql files: ${orphaned.join(", ")}`,
    ).toEqual([]);
  });

  it("journal entry idx values are sequential starting from 0", () => {
    const journal = readJournal();
    for (let i = 0; i < journal.entries.length; i++) {
      expect(journal.entries[i].idx, `Entry at position ${i} has wrong idx`).toBe(i);
    }
  });
});
