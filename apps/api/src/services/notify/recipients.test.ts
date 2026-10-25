import { describe, expect, it } from "vitest";
import type { Actor } from "../ownership.js";
import {
  selectRecipients,
  workCandidates,
  type Candidate,
  type WorkOwnership,
} from "./recipients.js";

/**
 * Who hears about a piece of work: its owner (or, for the organization's
 * work, whoever started it) and its team's admins — and only those of them
 * who may see it now (work-visibility.ts) and are still in its workspace.
 */

const WS = "ws-1";
const contacts = new Map(
  ["owner", "starter", "lead", "lead2", "member", "outsider", "admin", "gone"].map((id) => [
    id,
    { email: `${id}@example.test`, displayName: id },
  ]),
);

function actor(userId: string, over: Partial<Actor> = {}): Actor {
  return {
    userId,
    workspaceId: WS,
    isAdmin: false,
    teamIds: [],
    adminTeamIds: [],
    workVisibility: "teams",
    ...over,
  };
}

const actors = new Map<string, Actor | null>([
  ["owner", actor("owner", { teamIds: ["t-1"] })],
  ["starter", actor("starter")],
  ["lead", actor("lead", { teamIds: ["t-1"], adminTeamIds: ["t-1"] })],
  // An admin of another team.
  ["lead2", actor("lead2", { teamIds: ["t-2"], adminTeamIds: ["t-2"] })],
  ["member", actor("member", { teamIds: ["t-1"] })],
  ["outsider", actor("outsider")],
  ["admin", actor("admin", { isAdmin: true })],
  // Left the workspace.
  ["gone", null],
]);

const select = (
  candidates: Candidate[],
  work: WorkOwnership | null,
  workspaceId: string | null = WS,
) => selectRecipients({ candidates, contacts, actors, workspaceId, work }).map((r) => r.userId);

const addressed = (...ids: string[]): Candidate[] =>
  ids.map((userId) => ({ userId, reason: { why: "addressed" } }));

describe("workCandidates", () => {
  it("is the owner for a person's work", () => {
    expect(
      workCandidates({ workspaceId: WS, ownerUserId: "owner", createdBy: "starter" }, null),
    ).toEqual([{ userId: "owner", reason: { why: "owner" } }]);
  });

  it("is whoever started the organization's work", () => {
    expect(
      workCandidates({ workspaceId: WS, ownerUserId: null, createdBy: "starter" }, null),
    ).toEqual([{ userId: "starter", reason: { why: "creator" } }]);
  });

  it("adds the team's admins for a team's work", () => {
    const c = workCandidates(
      { workspaceId: WS, ownerUserId: "owner", ownerTeamId: "t-1" },
      { teamName: "Platform", userIds: ["lead"] },
    );
    expect(c).toEqual([
      { userId: "owner", reason: { why: "owner" } },
      { userId: "lead", reason: { why: "team-admin", teamName: "Platform" } },
    ]);
  });
});

describe("selectRecipients", () => {
  const teamWork: WorkOwnership = {
    workspaceId: WS,
    ownerUserId: "owner",
    ownerTeamId: "t-1",
    createdBy: "owner",
  };
  const privateWork: WorkOwnership = { workspaceId: WS, ownerUserId: "owner", createdBy: "owner" };
  const orgWork: WorkOwnership = { workspaceId: WS, ownerUserId: null, createdBy: "starter" };

  it("sends a team's work to its owner and its admins", () => {
    expect(
      select(workCandidates(teamWork, { teamName: "Platform", userIds: ["lead"] }), teamWork),
    ).toEqual(["owner", "lead"]);
  });

  it("keeps out anyone who may not see the work", () => {
    // Someone else's private work: only its owner and workspace admins see it.
    expect(select(addressed("owner", "member", "outsider", "lead2", "admin"), privateWork)).toEqual(
      ["owner", "admin"],
    );
    // A team's work: its members (and admins), not other teams' admins.
    expect(select(addressed("member", "lead2", "outsider"), teamWork)).toEqual(["member"]);
    // In "teams" mode the organization's work is its starter's and the admins'.
    expect(select(addressed("starter", "outsider", "admin"), orgWork)).toEqual([
      "starter",
      "admin",
    ]);
  });

  it("follows the organization mode: the organization's work is everyone's to see", () => {
    const orgMode = new Map(
      [...actors].map(([id, a]) => [
        id,
        a ? { ...a, workVisibility: "organization" as const } : null,
      ]),
    );
    const ids = selectRecipients({
      candidates: addressed("starter", "outsider"),
      contacts,
      actors: orgMode,
      workspaceId: WS,
      work: orgWork,
    }).map((r) => r.userId);
    expect(ids).toEqual(["starter", "outsider"]);
  });

  it("keeps someone without an email address (their chat hook may reach them)", () => {
    const noAddress = new Map<string, { email: string | null; displayName: string }>(contacts);
    noAddress.set("member", { email: null, displayName: "Member" });
    const r = selectRecipients({
      candidates: addressed("member"),
      contacts: noAddress,
      actors,
      workspaceId: WS,
      work: teamWork,
    });
    expect(r).toEqual([
      { userId: "member", email: null, displayName: "Member", reason: { why: "addressed" } },
    ]);
  });

  it("drops people who left the workspace, or whose account is disabled", () => {
    const noAddress = new Map(contacts);
    noAddress.delete("member");
    const ids = selectRecipients({
      candidates: addressed("gone", "member", "owner"),
      contacts: noAddress,
      actors,
      workspaceId: WS,
      work: teamWork,
    }).map((r) => r.userId);
    expect(ids).toEqual(["owner"]);
  });

  it("names each person once, with the first reason given", () => {
    const r = selectRecipients({
      candidates: [
        { userId: "lead", reason: { why: "owner" } },
        { userId: "lead", reason: { why: "team-admin", teamName: "Platform" } },
      ],
      contacts,
      actors,
      workspaceId: WS,
      work: teamWork,
    });
    expect(r).toEqual([
      { userId: "lead", email: "lead@example.test", displayName: "lead", reason: { why: "owner" } },
    ]);
  });

  it("without a work, sends to any member of the workspace", () => {
    expect(select(addressed("outsider", "gone", "member"), null)).toEqual(["outsider", "member"]);
  });

  it("sends work with no workspace (older rows) to its owner only", () => {
    const legacy: WorkOwnership = { workspaceId: null, ownerUserId: "owner" };
    expect(select(addressed("owner", "admin"), legacy, null)).toEqual(["owner"]);
  });
});
