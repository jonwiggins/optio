import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// The Team owner choice shows only while teams are on and the viewer is in one.
const mocks = vi.hoisted(() => ({
  teams: false,
  myTeams: [] as Array<{ id: string; name: string }>,
}));
vi.mock("@/hooks/use-deployment-switches", () => ({
  useDeploymentSwitches: () => ({ teams: mocks.teams, loaded: true }),
}));
vi.mock("@/hooks/use-my-teams", () => ({
  useMyTeams: () => ({ teams: [], myTeams: mocks.myTeams, loaded: true, reload: vi.fn() }),
}));

import { OwnerRow } from "./who-extras";
import { ownerFromRow } from "./load";

const TEAM = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  mocks.teams = false;
  mocks.myTeams = [];
});

describe("OwnerRow", () => {
  it("offers Organization and Private only, with teams off (the default)", () => {
    mocks.myTeams = [{ id: TEAM, name: "Platform" }];
    render(<OwnerRow owner="workspace" onChange={vi.fn()} />);
    expect(screen.queryByRole("radio", { name: /Team/ })).toBeNull();
    expect(screen.queryByText("Team")).toBeNull();
  });

  it("offers the viewer's teams with teams on", () => {
    mocks.teams = true;
    mocks.myTeams = [{ id: TEAM, name: "Platform" }];
    const onChange = vi.fn();
    render(<OwnerRow owner="workspace" onChange={onChange} />);
    fireEvent.click(screen.getByText("Team"));
    expect(onChange).toHaveBeenCalledWith(`team:${TEAM}`);
  });

  it("shows the team a team's work belongs to", () => {
    mocks.teams = true;
    mocks.myTeams = [{ id: TEAM, name: "Platform" }];
    render(<OwnerRow owner={`team:${TEAM}`} onChange={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "Team" })).toHaveValue(TEAM);
  });
});

describe("ownerFromRow", () => {
  it("reads a team's row as the team's, editable by its members", () => {
    expect(ownerFromRow({ ownerUserId: "creator", ownerTeamId: TEAM }, "someone-else")).toEqual({
      owner: `team:${TEAM}`,
      foreignOwnerId: null,
    });
    expect(ownerFromRow({ ownerUserId: "creator" }, "someone-else").owner).toBe("me");
  });
});
