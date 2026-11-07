import { describe, expect, it, vi } from "vitest";

const execute = vi.fn();
vi.mock("../db/client.js", () => ({ db: { execute: (...a: unknown[]) => execute(...a) } }));
const warn = vi.fn();
vi.mock("../logger.js", () => ({
  logger: { warn: (...a: unknown[]) => warn(...a), debug: vi.fn(), info: vi.fn() },
}));

import {
  RETENTION_MAX_DAYS,
  isPromptPruned,
  pruneRunData,
  runLogRetentionDays,
} from "./run-retention.js";

const days = (value: string | undefined) =>
  runLogRetentionDays(value === undefined ? {} : { OPTIO_RUN_LOG_RETENTION_DAYS: value });

describe("runLogRetentionDays", () => {
  it("is off (null) when unset, empty or 0: everything is kept, as before", () => {
    expect(days(undefined)).toBeNull();
    expect(days("")).toBeNull();
    expect(days("  ")).toBeNull();
    expect(days("0")).toBeNull();
  });

  it("reads whole days from 1 to the maximum", () => {
    expect(days("1")).toBe(1);
    expect(days(" 90 ")).toBe(90);
    expect(days(String(RETENTION_MAX_DAYS))).toBe(RETENTION_MAX_DAYS);
  });

  it("keeps everything for a value it can't read, and says so once", () => {
    for (const bad of ["-5", "1.5", "30d", "abc", String(RETENTION_MAX_DAYS + 1), "1e3"]) {
      expect(days(bad)).toBeNull();
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("isPromptPruned", () => {
  it("is true only for a run the retention cleared", () => {
    expect(isPromptPruned({ metadata: { retention: { prunedAt: "2026-01-01T00:00:00Z" } } })).toBe(
      true,
    );
    expect(isPromptPruned({ metadata: null })).toBe(false);
    expect(isPromptPruned({ metadata: { run: {} } })).toBe(false);
    expect(isPromptPruned({})).toBe(false);
  });
});

describe("pruneRunData", () => {
  it("does nothing at all when retention is off", async () => {
    expect(await pruneRunData(new Date(), null)).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });
});
