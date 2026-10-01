import { describe, expect, it } from "vitest";
import { compareSessions, nextNeedsYou, orderSessions, sessionOrder } from "./session-order";

const t = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  state: "running",
  attentionState: "working",
  createdAt: "2026-09-01T00:00:00Z",
  lastInteractedAt: null as string | null,
  ...extra,
});

describe("session order", () => {
  it("orders by lastInteractedAt ?? createdAt, newest first", () => {
    const rows = [
      t("old", { createdAt: "2026-09-01T00:00:00Z" }),
      t("new", { createdAt: "2026-09-03T00:00:00Z" }),
      t("typed", { createdAt: "2026-08-01T00:00:00Z", lastInteractedAt: "2026-09-04T00:00:00Z" }),
    ];
    expect(sessionOrder(rows).map((r) => r.id)).toEqual(["typed", "new", "old"]);
  });

  it("breaks ties by createdAt, then id", () => {
    const at = "2026-09-05T00:00:00Z";
    const rows = [
      t("b", { lastInteractedAt: at, createdAt: "2026-09-01T00:00:00Z" }),
      t("a", { lastInteractedAt: at, createdAt: "2026-09-01T00:00:00Z" }),
      t("c", { lastInteractedAt: at, createdAt: "2026-09-02T00:00:00Z" }),
    ];
    expect([...rows].sort(compareSessions).map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("ignores attention state and activity — rows don't move when an agent flips", () => {
    const rows = [
      t("x", { createdAt: "2026-09-02T00:00:00Z" }),
      t("y", { createdAt: "2026-09-01T00:00:00Z" }),
    ];
    const before = sessionOrder(rows).map((r) => r.id);
    rows[1].attentionState = "needs_you";
    (rows[1] as any).lastActivityAt = "2026-09-30T00:00:00Z";
    expect(sessionOrder(rows).map((r) => r.id)).toEqual(before);
  });

  it("puts finished sessions in their own section below live ones", () => {
    const { live, finished } = orderSessions([
      t("done", { state: "exited", createdAt: "2026-09-09T00:00:00Z" }),
      t("pending", { state: "pending" }),
      t("err", { state: "error" }),
      t("launch", { state: "launching", createdAt: "2026-09-02T00:00:00Z" }),
    ]);
    expect(live.map((r) => r.id)).toEqual(["launch", "pending"]);
    expect(finished.map((r) => r.id)).toEqual(["done", "err"]);
  });

  it("jumps to the next needs-you session after the active one, wrapping", () => {
    const ordered = [
      t("a", { attentionState: "needs_you" }),
      t("b"),
      t("c", { attentionState: "needs_you" }),
    ];
    expect(nextNeedsYou(ordered, null)?.id).toBe("a");
    expect(nextNeedsYou(ordered, "a")?.id).toBe("c");
    expect(nextNeedsYou(ordered, "b")?.id).toBe("c");
    expect(nextNeedsYou(ordered, "c")?.id).toBe("a");
    expect(nextNeedsYou([t("a", { attentionState: "needs_you" })], "a")).toBeNull();
    expect(nextNeedsYou([t("a")], null)).toBeNull();
  });
});
