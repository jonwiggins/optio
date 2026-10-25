import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { podIsolationKey } from "./pod-isolation.js";

/** The key as upstream computes it (v1), with no team. */
function upstreamKey(scope: {
  workspaceId?: string | null;
  ownerUserId?: string | null;
  isolationPurpose?: string;
  credentialProfile?: unknown;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "v1",
        scope.workspaceId ?? null,
        scope.ownerUserId ?? null,
        scope.isolationPurpose ?? "work",
        scope.credentialProfile ?? null,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

describe("podIsolationKey and a team's work", () => {
  const scope = {
    workspaceId: "ws-1",
    ownerUserId: "user-1",
    isolationPurpose: "work",
    credentialProfile: [{ setupCommands: "make" }, ["NPM_TOKEN"], null],
  };

  it("is upstream's key for everything that isn't a team's", () => {
    expect(podIsolationKey(scope)).toBe(upstreamKey(scope));
    expect(podIsolationKey({ ...scope, teamId: null })).toBe(upstreamKey(scope));
    expect(podIsolationKey({ ...scope, teamId: undefined })).toBe(upstreamKey(scope));
    expect(podIsolationKey({})).toBe(upstreamKey({}));
  });

  it("a team's work never shares its creator's personal pods, nor another team's", () => {
    const personal = podIsolationKey(scope);
    const teamA = podIsolationKey({ ...scope, teamId: "team-a" });
    const teamB = podIsolationKey({ ...scope, teamId: "team-b" });
    expect(new Set([personal, teamA, teamB]).size).toBe(3);
    expect(podIsolationKey({ ...scope, teamId: "team-a" })).toBe(teamA);
  });
});
