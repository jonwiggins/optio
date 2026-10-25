import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CredentialHealthRow } from "@/lib/credential-health-api";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let currentUser: any;
vi.mock("@/hooks/use-current-user", () => ({ useCurrentUser: () => currentUser }));

const list = vi.fn();
const check = vi.fn();
const checkMine = vi.fn();
const checkAll = vi.fn();
vi.mock("@/lib/credential-health-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/credential-health-api")>();
  return {
    ...actual,
    credentialHealthApi: {
      list: (mine?: boolean) => list(mine),
      check: (key: string) => check(key),
      checkMine: () => checkMine(),
      checkAll: () => checkAll(),
    },
  };
});

import { MyCredentialHealth, SystemHealth } from "./system-health";
import { expiresIn, healthSummary } from "@/lib/credential-health-api";

const DAY = 86_400_000;
const now = Date.now();

const teamToken: CredentialHealthRow = {
  key: "gateway:g1:team:t1",
  kind: "gateway",
  label: "Gateway token · LiteLLM",
  scope: "team",
  owner: { name: "Team · Platform", userId: null, teamId: "t1" },
  status: "error",
  reason: "Over budget until 2026-11-01 00:00 UTC: 5.10 of 5.00 USD spent",
  expiresAt: null,
  checkedAt: new Date(now - 60_000).toISOString(),
  details: { spend: 5.1, maxBudget: 5 },
};
const orgGitlab: CredentialHealthRow = {
  key: "gitlab:org",
  kind: "gitlab",
  label: "GitLab token",
  scope: "organization",
  owner: { name: "Organization", userId: null, teamId: null },
  status: "warning",
  reason: "Expires in 7 days (2026-10-31 00:00 UTC)",
  expiresAt: new Date(now + 6.5 * DAY).toISOString(),
  checkedAt: new Date(now - 120_000).toISOString(),
  details: { host: "gitlab.example.test", scopes: ["api"] },
};
const mine: CredentialHealthRow = {
  ...orgGitlab,
  key: "gitlab:user:u1",
  scope: "person",
  owner: { name: "Jon", userId: "u1", teamId: null },
  status: "ok",
  reason: null,
  expiresAt: null,
};

beforeEach(() => {
  currentUser = {
    user: { id: "u1", adminTeamIds: [] },
    isAdmin: false,
    isDeploymentAdmin: true,
    loaded: true,
  };
  for (const f of [list, check, checkMine, checkAll]) f.mockReset();
});
afterEach(() => cleanup());

describe("Settings → System health", () => {
  it("isn't there for a member who administers nothing", () => {
    currentUser = { ...currentUser, isDeploymentAdmin: false };
    const { container } = render(<SystemHealth />);
    expect(container).toBeEmptyDOMElement();
    expect(list).not.toHaveBeenCalled();
  });

  it("shows each credential: what, whose, status, reason, expiry, last check", async () => {
    list.mockResolvedValue({
      rows: [teamToken, orgGitlab],
      canCheckAll: true,
      lastCheckedAt: orgGitlab.checkedAt,
    });
    render(<SystemHealth />);
    const row = await screen.findByTestId("health-row-gateway:g1:team:t1");
    expect(within(row).getByText("Gateway token · LiteLLM")).toBeInTheDocument();
    expect(within(row).getByText("Team · Platform")).toBeInTheDocument();
    expect(within(row).getByText("Failing")).toBeInTheDocument();
    expect(within(row).getByText(/Over budget until 2026-11-01 00:00 UTC/)).toBeInTheDocument();
    expect(within(row).getByText(/No expiry reported/)).toBeInTheDocument();
    const gitlab = screen.getByTestId("health-row-gitlab:org");
    expect(within(gitlab).getByText("Warning")).toBeInTheDocument();
    expect(within(gitlab).getByText(/\(in 7 days\)/)).toBeInTheDocument();
    expect(screen.getByText("1 failing, 1 warning")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Check all/ })).toBeInTheDocument();
  });

  it("Check now replaces the row with what the check found", async () => {
    list.mockResolvedValue({ rows: [teamToken], canCheckAll: false, lastCheckedAt: null });
    check.mockResolvedValue({ row: { ...teamToken, status: "ok", reason: null } });
    currentUser = {
      ...currentUser,
      isDeploymentAdmin: false,
      user: { id: "u1", adminTeamIds: ["t1"] },
    };
    render(<SystemHealth />);
    const button = await screen.findByRole("button", { name: /Check Gateway token/ });
    expect(screen.queryByRole("button", { name: /Check all/ })).not.toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(check).toHaveBeenCalledWith("gateway:g1:team:t1"));
    expect(await screen.findByText("OK")).toBeInTheDocument();
    expect(screen.queryByText(/Over budget/)).not.toBeInTheDocument();
  });

  it("Check all starts a pass", async () => {
    list.mockResolvedValue({ rows: [orgGitlab], canCheckAll: true, lastCheckedAt: null });
    checkAll.mockResolvedValue({ started: true });
    render(<SystemHealth />);
    fireEvent.click(await screen.findByRole("button", { name: /Check all/ }));
    await waitFor(() => expect(checkAll).toHaveBeenCalled());
  });
});

describe("My tokens → Health", () => {
  it("lists the person's own and checks them all at once", async () => {
    list.mockResolvedValue({ rows: [], canCheckAll: false, lastCheckedAt: null });
    checkMine.mockResolvedValue({ rows: [mine] });
    render(<MyCredentialHealth />);
    await waitFor(() => expect(list).toHaveBeenCalledWith(true));
    expect(screen.getByText(/Not checked yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Check my tokens/ }));
    expect(await screen.findByTestId("health-row-gitlab:user:u1")).toBeInTheDocument();
    expect(screen.getByText("All working")).toBeInTheDocument();
    // Their own: no owner name on the row.
    expect(screen.queryByText("Jon")).not.toBeInTheDocument();
  });
});

describe("the wording", () => {
  it("counts days as the API does, and sums up the statuses", () => {
    const at = new Date("2026-10-24T12:00:00Z");
    expect(expiresIn("2026-10-25T00:00:00Z", at)).toBe("in 1 day");
    expect(expiresIn("2026-10-31T00:00:00Z", at)).toBe("in 7 days");
    expect(expiresIn("2026-10-24T00:00:00Z", at)).toBe("expired");
    expect(healthSummary([mine])).toBeNull();
    expect(healthSummary([teamToken, teamToken, orgGitlab])).toBe("2 failing, 1 warning");
  });
});
