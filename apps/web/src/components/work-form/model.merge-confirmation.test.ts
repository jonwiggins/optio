import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT, followThrough, withMergeConfirmation } from "./model";
import { specFor } from "./submit";

// "Merge it for me" under the deployment's merge confirmation
// (docs/merge-confirmation.md).

const base = { ...EMPTY_DRAFT, prompt: "p", repoUrl: "https://github.com/a/b" };
const untilMerged = { ...base, then: "until-merged" as const, mergeWhenReady: true };
const merges = (plan: ReturnType<typeof followThrough>) =>
  plan!.steps.some((s) => s.key === "merge" && s.on);

describe("withMergeConfirmation", () => {
  it("leaves the draft alone without the confirmation", () => {
    expect(withMergeConfirmation(untilMerged, false)).toBe(untilMerged);
  });

  it("turns an unconfirmed 'Merge it for me' off", () => {
    expect(withMergeConfirmation(untilMerged, true).mergeWhenReady).toBe(false);
  });

  it("keeps one confirmed in this edit, or confirmed before", () => {
    expect(
      withMergeConfirmation({ ...untilMerged, autoMergeConfirmed: true }, true).mergeWhenReady,
    ).toBe(true);
    expect(
      withMergeConfirmation({ ...untilMerged, autoMergeConfirmedAt: "2026-10-01T00:00:00Z" }, true)
        .mergeWhenReady,
    ).toBe(true);
  });
});

describe("followThrough with the confirmation on", () => {
  const repo = { autoResume: false, autoMerge: true };

  it("a repo's auto-merge nobody confirmed merges nothing", () => {
    expect(merges(followThrough(base, repo))).toBe(true);
    expect(merges(followThrough(base, repo, true))).toBe(false);
    expect(
      merges(followThrough(base, { ...repo, autoMergeConfirmedAt: "2026-10-01T00:00:00Z" }, true)),
    ).toBe(true);
  });
});

describe("specFor", () => {
  it("sends autoMergeConfirmed only when the dialog was accepted in this edit", () => {
    const ctx = { repoUrl: base.repoUrl, name: "n" };
    expect(specFor(untilMerged, ctx)).not.toHaveProperty("autoMergeConfirmed");
    expect(specFor({ ...untilMerged, autoMergeConfirmed: true }, ctx)).toMatchObject({
      mergeWhenReady: true,
      autoMergeConfirmed: true,
    });
    expect(
      specFor({ ...untilMerged, mergeWhenReady: false, autoMergeConfirmed: true }, ctx),
    ).not.toHaveProperty("autoMergeConfirmed");
  });
});
