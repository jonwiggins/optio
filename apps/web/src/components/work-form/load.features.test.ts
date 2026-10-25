import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({ api: {} }));

import { draftFromRow, ownerFromRow } from "./load";
import { withMergeConfirmation } from "./model";

const ME = "u-me";
const REPO = "https://github.com/acme/app";

describe("a team's row", () => {
  it("answers team:<id>, whoever made it, and stays editable (the server decides)", () => {
    const TEAM = "11111111-2222-4333-8444-555555555555";
    expect(ownerFromRow({ ownerUserId: "u-x", ownerTeamId: TEAM }, ME)).toEqual({
      owner: `team:${TEAM}`,
      foreignOwnerId: null,
    });
    const row = { kind: "standalone", name: "J", agentType: "claude-code", prompt: "hi" };
    expect(draftFromRow({ ...row, ownerUserId: "u-x", ownerTeamId: TEAM }, null, ME).owner).toBe(
      `team:${TEAM}`,
    );
  });
});

describe("loading a scheduled Task's follow-through under the automatic-merge confirmation", () => {
  const row = {
    kind: "repo-blueprint",
    name: "Assign",
    prompt: "fix {{ticketTitle}}",
    repoUrl: REPO,
    repoBranch: "main",
    agentType: "claude-code",
    autoResume: true,
    autoMerge: true,
  };

  it("carries when its automatic merging was confirmed, and stays on", () => {
    const confirmed = draftFromRow({ ...row, autoMergeConfirmedAt: "2026-10-01T00:00:00Z" }, null);
    expect(confirmed.mergeWhenReady).toBe(true);
    expect(confirmed.autoMergeConfirmedAt).toBe("2026-10-01T00:00:00Z");
    expect(confirmed.autoMergeConfirmed).toBeUndefined();
    expect(withMergeConfirmation(confirmed, true).mergeWhenReady).toBe(true);
  });

  it("opens one nobody confirmed as off with the confirmation on (it merges nothing)", () => {
    const unconfirmed = draftFromRow({ ...row, autoMergeConfirmedAt: null }, null);
    expect(unconfirmed.autoMergeConfirmedAt).toBeUndefined();
    // Without the confirmation (the default) the row's own setting decides.
    expect(unconfirmed.mergeWhenReady).toBe(true);
    expect(withMergeConfirmation(unconfirmed, true).mergeWhenReady).toBe(false);
  });
});
