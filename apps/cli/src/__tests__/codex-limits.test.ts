import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import {
  listRolloutFiles,
  parseRolloutLine,
  readCodexLimits,
  lastLimitsInFile,
} from "../local/codex-limits.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const event = (ts: string, primary: any, secondary: any = null, extra: any = {}) =>
  JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { total_tokens: 1 } },
      rate_limits: { limit_id: "codex", primary, secondary, plan_type: "prolite", ...extra },
    },
  });

function sessions(files: Array<{ rel: string; lines: string[]; mtime: number }>): string {
  const root = mkdtempSync(join(tmpdir(), "optio-codex-"));
  dirs.push(root);
  for (const f of files) {
    const p = join(root, f.rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, f.lines.join("\n") + "\n");
    utimesSync(p, f.mtime / 1000, f.mtime / 1000);
  }
  return root;
}

describe("parseRolloutLine", () => {
  it("reads primary / secondary windows, epoch resets, plan, and timestamp", () => {
    const parsed = parseRolloutLine(
      event(
        "2026-08-11T08:18:24.164Z",
        { used_percent: 12.5, window_minutes: 300, resets_at: 1786931601 },
        { used_percent: 40, window_minutes: 10080, resets_at: 1787000000 },
      ),
    );
    expect(parsed).toEqual({
      primary: {
        usedPercent: 12.5,
        windowMinutes: 300,
        resetsAt: new Date(1786931601 * 1000).toISOString(),
      },
      secondary: {
        usedPercent: 40,
        windowMinutes: 10080,
        resetsAt: new Date(1787000000 * 1000).toISOString(),
      },
      planType: "prolite",
      observedAt: "2026-08-11T08:18:24.164Z",
    });
  });

  it("ignores lines without limits, clamps percentages", () => {
    expect(parseRolloutLine(JSON.stringify({ type: "response_item", payload: {} }))).toBeNull();
    expect(parseRolloutLine("nope")).toBeNull();
    const p = parseRolloutLine(event("2026-08-11T00:00:00Z", { used_percent: 140 }));
    expect(p?.primary?.usedPercent).toBe(100);
    expect(p?.primary?.windowMinutes).toBeNull();
  });
});

describe("readCodexLimits", () => {
  it("returns the newest snapshot across rollouts, reading the last one in each file", () => {
    const root = sessions([
      {
        rel: "2026/08/10/rollout-a.jsonl",
        mtime: Date.parse("2026-08-10T00:00:00Z"),
        lines: [
          event("2026-08-10T01:00:00Z", { used_percent: 5 }),
          event("2026-08-10T02:00:00Z", { used_percent: 9 }),
        ],
      },
      {
        rel: "2026/08/11/rollout-b.jsonl",
        mtime: Date.parse("2026-08-11T00:00:00Z"),
        lines: [
          JSON.stringify({ type: "session_meta", payload: {} }),
          event("2026-08-11T01:00:00Z", { used_percent: 21, window_minutes: 10080 }),
          JSON.stringify({ type: "response_item", payload: { type: "message" } }),
        ],
      },
    ]);
    expect(listRolloutFiles(root).map((p) => p.split("/").pop())).toEqual([
      "rollout-b.jsonl",
      "rollout-a.jsonl",
    ]);
    expect(lastLimitsInFile(join(root, "2026/08/10/rollout-a.jsonl"))?.primary?.usedPercent).toBe(
      9,
    );
    const best = readCodexLimits(root);
    expect(best?.primary?.usedPercent).toBe(21);
    expect(best?.observedAt).toBe("2026-08-11T01:00:00.000Z");
  });

  it("is null when there are no sessions", () => {
    const root = sessions([]);
    expect(readCodexLimits(root)).toBeNull();
    expect(readCodexLimits(join(root, "missing"))).toBeNull();
  });
});
