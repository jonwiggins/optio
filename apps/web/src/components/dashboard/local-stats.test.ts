import { describe, it, expect } from "vitest";
import {
  computeLocalStats,
  isLocalQuiet,
  recentLocalTerminals,
  RECENT_WINDOW_MS,
} from "./local-stats";
import { collectNeedsYou } from "./needs-you";

const NOW = Date.parse("2026-09-17T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const t = (id: string, state: string, attentionState: string, lastActivityAt: string) => ({
  id,
  title: id,
  dir: `/home/dev/${id}`,
  state,
  attentionState,
  attentionReason: attentionState === "needs_you" ? "stop" : null,
  lastActivityAt,
});

describe("computeLocalStats", () => {
  it("rolls terminals and hosts up", () => {
    const s = computeLocalStats(
      [
        t("a", "running", "working", ago(1000)),
        t("b", "running", "idle", ago(1000)),
        t("c", "pending", "idle", ago(1000)),
        t("d", "running", "needs_you", ago(1000)),
        t("e", "exited", "idle", ago(1000)),
        t("f", "error", "idle", ago(1000)),
      ],
      [{ state: "online" }, { state: "offline" }],
    );
    expect(s).toEqual({
      total: 6,
      needsYou: 1,
      working: 1,
      idle: 2,
      finished: 2,
      hosts: 2,
      hostsOnline: 1,
    });
  });
});

describe("recentLocalTerminals", () => {
  it("keeps live ones and last-24h finishes, needs-you (oldest wait) first", () => {
    const list = recentLocalTerminals(
      [
        t("old-exit", "exited", "idle", ago(RECENT_WINDOW_MS + 1)),
        t("fresh-exit", "exited", "idle", ago(60_000)),
        t("working", "running", "working", ago(5_000)),
        t("wait-new", "running", "needs_you", ago(10_000)),
        t("wait-old", "running", "needs_you", ago(600_000)),
        t("idle-live", "running", "idle", ago(RECENT_WINDOW_MS * 3)),
      ],
      NOW,
    ).map((x) => x.id);
    expect(list).toEqual(["wait-old", "wait-new", "working", "fresh-exit", "idle-live"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 10 }, (_, i) => t(`t${i}`, "running", "idle", ago(i)));
    expect(recentLocalTerminals(many, NOW, 3)).toHaveLength(3);
  });
});

describe("isLocalQuiet", () => {
  it("is quiet with no stats or nothing live and nothing recent", () => {
    expect(isLocalQuiet(null, [])).toBe(true);
    expect(
      isLocalQuiet(
        { total: 4, needsYou: 0, working: 0, idle: 0, finished: 4, hosts: 1, hostsOnline: 1 },
        [],
      ),
    ).toBe(true);
  });

  it("is not quiet with anything live or a recent finish", () => {
    const base = {
      total: 1,
      needsYou: 0,
      working: 0,
      idle: 0,
      finished: 0,
      hosts: 1,
      hostsOnline: 1,
    };
    expect(isLocalQuiet({ ...base, idle: 1 }, [])).toBe(false);
    expect(isLocalQuiet(base, [t("x", "exited", "idle", ago(1))])).toBe(false);
  });
});

describe("collectNeedsYou", () => {
  it("merges local terminals and tasks, oldest wait first", () => {
    const items = collectNeedsYou(
      [t("term", "running", "needs_you", ago(300_000)), t("busy", "running", "working", ago(1))],
      [
        {
          id: "task1",
          title: "Fix flaky test",
          repoUrl: "https://github.com/acme/optio",
          errorMessage: "merge conflict",
          updatedAt: ago(900_000),
        },
      ],
    );
    expect(items.map((i) => i.key)).toEqual(["task-task1", "local-term"]);
    expect(items[0]).toMatchObject({
      kind: "task",
      href: "/tasks/task1",
      where: "acme/optio",
      reason: "merge conflict",
    });
    expect(items[1]).toMatchObject({ kind: "local", href: "/local/term", where: "dev/term" });
  });
});
