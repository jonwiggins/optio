/**
 * The controller's row check follows the workspace's work-visibility mode
 * (work-visibility.ts), like the HTTP routes: in "teams" mode the
 * organization's work reads as missing to a member, a team's work reaches
 * its members, and nothing widens for an agent that connects over MCP.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("./oauth/index.js", () => ({ isAuthDisabled: () => false }));

import type { Actor } from "./ownership.js";
import { requireVisible } from "./controller-access.js";
import type { ControllerPrincipal } from "./controller-auth.js";

const me = "11111111-1111-1111-1111-111111111111";
const other = "22222222-2222-2222-2222-222222222222";
const myTeam = "33333333-3333-3333-3333-333333333333";
const otherTeam = "44444444-4444-4444-4444-444444444444";

const principal = (over: Partial<Actor> = {}): ControllerPrincipal =>
  ({
    actor: {
      userId: me,
      workspaceId: "ws-1",
      isAdmin: false,
      teamIds: [myTeam],
      adminTeamIds: [],
      workVisibility: "teams",
      ...over,
    },
    access: "manage",
    name: "me",
  }) as ControllerPrincipal;

const row = (over: Record<string, unknown> = {}) => ({
  workspaceId: "ws-1",
  ownerUserId: null as string | null,
  ownerTeamId: null as string | null,
  createdBy: null as string | null,
  ...over,
});

describe("requireVisible", () => {
  it("hides the organization's work from a member in teams mode", () => {
    expect(() => requireVisible(principal(), row())).toThrow("Work not found");
  });

  it("shows it in organization mode, and to an admin in teams mode", () => {
    expect(() =>
      requireVisible(principal({ workVisibility: "organization" }), row()),
    ).not.toThrow();
    expect(() => requireVisible(principal({ isAdmin: true }), row())).not.toThrow();
  });

  it("shows own, created-by and the actor's teams' work; not another team's", () => {
    expect(() => requireVisible(principal(), row({ ownerUserId: me }))).not.toThrow();
    expect(() => requireVisible(principal(), row({ createdBy: me }))).not.toThrow();
    expect(() =>
      requireVisible(principal(), row({ ownerUserId: other, ownerTeamId: myTeam })),
    ).not.toThrow();
    expect(() =>
      requireVisible(principal(), row({ ownerUserId: other, ownerTeamId: otherTeam })),
    ).toThrow("Work not found");
  });

  it("refuses another workspace's row whatever its owner", () => {
    expect(() =>
      requireVisible(principal({ isAdmin: true }), row({ workspaceId: "ws-2", ownerUserId: me })),
    ).toThrow("Work not found");
  });
});
