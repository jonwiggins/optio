/**
 * Tables the Work unification folded into others (docs/plans/work-unification.md).
 * Raw SQL that still names one typechecks fine and only fails at runtime, so
 * this test fails instead when any source file mentions one. Migrations and
 * the tests that seed the old shapes are the only places the old names live.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const DROPPED_TABLES = [
  "persistent_agent_turn_logs",
  "repo_pods",
  "workflow_pods",
  "persistent_agent_pods",
  "repo_pod_state",
  "workflow_pod_state",
];

const SRC = join(import.meta.dirname, "..");
const ALLOWED = new Set([
  "db/dropped-tables.test.ts",
  "db/work-unification-migrations.int.test.ts",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "migrations" ? [] : sourceFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

describe("dropped tables", () => {
  it("are not named anywhere in the API source", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, "utf-8");
      for (const table of DROPPED_TABLES) {
        if (new RegExp(`\\b${table}\\b`).test(text)) offenders.push(`${rel}: ${table}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
