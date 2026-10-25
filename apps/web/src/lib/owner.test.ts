import { describe, expect, it } from "vitest";
import {
  countByOwner,
  groupByOwner,
  inOwnerFilter,
  ownerOf,
  ownerScope,
  parseOwnerFilter,
  pickedTeamId,
  scopeOf,
  teamHint,
  workOwnerFilters,
  workOwnerLabel,
  workVisibilityHint,
} from "./owner";

const TEAM = "11111111-2222-4333-8444-555555555555";

const org = { id: "org", ownerUserId: null, ownerTeamId: null };
const mine = { id: "mine", ownerUserId: "u-me" };
const theirs = { id: "theirs", ownerUserId: "u-x", ownerName: "Sam" };
const teams = { id: "team", ownerUserId: "u-x", ownerTeamId: TEAM, ownerTeamName: "Platform" };

describe("ownerScope: where a row falls", () => {
  it("the organization's, yours, someone else's", () => {
    expect(ownerScope(org, "u-me")).toBe("organization");
    expect(ownerScope(mine, "u-me")).toBe("private");
    expect(ownerScope(theirs, "u-me")).toBe("others");
  });

  it("a team's row is the team's whoever made it, even for an admin outside the team", () => {
    expect(ownerScope(teams, "u-me", [])).toBe("team");
    expect(ownerScope(teams, "u-x", [TEAM])).toBe("team");
  });

  it("a caller that knows only three scopes sees a team's row as a shared one", () => {
    expect(ownerScope(teams, "u-me")).toBe("organization");
    expect(ownerScope(teams, "u-x")).toBe("organization");
  });

  it("with auth disabled every private row is the viewer's", () => {
    expect(ownerScope(theirs, null)).toBe("private");
  });
});

describe("the picker's value and the owner on the wire", () => {
  it("ownerOf / scopeOf round-trip the organization and private", () => {
    expect(ownerOf("organization")).toBe("workspace");
    expect(ownerOf("private")).toBe("me");
    expect(scopeOf("workspace")).toBe("organization");
    expect(scopeOf("me")).toBe("private");
    expect(scopeOf(null)).toBe("organization");
  });

  it("a team passes through as team:<id>", () => {
    expect(ownerOf(`team:${TEAM}`)).toBe(`team:${TEAM}`);
    expect(scopeOf(`team:${TEAM}`)).toBe(`team:${TEAM}`);
    expect(pickedTeamId(`team:${TEAM}`)).toBe(TEAM);
    expect(pickedTeamId("private")).toBeNull();
    expect(pickedTeamId("workspace")).toBeNull();
  });
});

describe("filters and counts", () => {
  const rows = [org, mine, theirs, teams];

  it("counts every scope", () => {
    expect(countByOwner(rows, "u-me")).toEqual({
      all: 4,
      organization: 1,
      team: 1,
      private: 1,
      others: 1,
    });
  });

  it("filters to one scope, or keeps everything", () => {
    expect(inOwnerFilter(rows, "team", "u-me").map((r) => r.id)).toEqual(["team"]);
    expect(inOwnerFilter(rows, "private", "u-me").map((r) => r.id)).toEqual(["mine"]);
    expect(inOwnerFilter(rows, "all", "u-me")).toHaveLength(4);
  });

  it("groups the team's rows apart for the sections", () => {
    const by = groupByOwner(rows, "u-me");
    expect(by.organization.map((r) => r.id)).toEqual(["org"]);
    expect(by.team.map((r) => r.id)).toEqual(["team"]);
    expect(by.private.map((r) => r.id)).toEqual(["mine"]);
    expect(by.others.map((r) => r.id)).toEqual(["theirs"]);
  });

  it("parses ?owner= and falls back to all", () => {
    expect(parseOwnerFilter("team")).toBe("team");
    expect(parseOwnerFilter("others")).toBe("others");
    expect(parseOwnerFilter("nope")).toBe("all");
    expect(parseOwnerFilter(null)).toBe("all");
  });

  it("the Team section's empty line names the resource", () => {
    expect(teamHint("secrets")).toMatch(/^Team secrets are shared with a team/);
  });
});

describe("work under the workspace's visibility mode", () => {
  it("drops Other people's for a member under teams, keeps it for admins and in organization mode", () => {
    expect(workOwnerFilters("teams", false)).not.toContain("others");
    expect(workOwnerFilters("teams", true)).toContain("others");
    expect(workOwnerFilters("organization", false)).toContain("others");
  });

  it("labels a member's organization rows as theirs under teams", () => {
    expect(workOwnerLabel("organization", "teams", false)).toBe("Organization · made by you");
    expect(workOwnerLabel("organization", "teams", true)).toBe("Organization");
    expect(workOwnerLabel("team", "teams", false)).toBe("Team");
    expect(workVisibilityHint("teams")).toMatch(/your teams'/);
  });
});
