import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TeamGatewayKey as TeamKeyStatus } from "@/lib/gateway-keys-api";

// Teams → a team → Tokens: the key Optio makes for a team, and its budget.

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const getTeamKey = vi.fn();
const createTeamKey = vi.fn();
const setTeamBudget = vi.fn();
const revokeTeamKey = vi.fn();
vi.mock("@/lib/gateway-keys-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/gateway-keys-api")>()),
  gatewayKeysApi: {
    getTeamKey: (...a: unknown[]) => getTeamKey(...a),
    createTeamKey: (...a: unknown[]) => createTeamKey(...a),
    setTeamBudget: (...a: unknown[]) => setTeamBudget(...a),
    revokeTeamKey: (...a: unknown[]) => revokeTeamKey(...a),
  },
}));

import { TeamGatewayBudgetCard, TeamGatewayKey } from "./team-gateway-key";

function teamKey(patch: Partial<TeamKeyStatus> = {}): TeamKeyStatus {
  return {
    team: { id: "t1", name: "Platform" },
    gateway: { id: "g1", name: "LiteLLM" },
    modes: { personalPasted: true, optioIssued: true },
    canIssue: true,
    canManage: true,
    hasToken: false,
    issued: null,
    budget: null,
    defaults: { maxBudget: 50, budgetDuration: "30d" },
    budgetCap: 50,
    ...patch,
  };
}

const issued = {
  id: "k1",
  kind: "team" as const,
  keyAlias: "optio-team-platform",
  keyHint: "9f9f",
  models: [],
  maxBudget: 50,
  budgetDuration: "30d",
  expiresAt: null,
  createdAt: "2026-10-24T00:00:00.000Z",
  spendUsd: null,
  budgetResetAt: null,
  checkedAt: null,
};

beforeEach(() => {
  getTeamKey.mockReset();
  createTeamKey.mockReset();
  setTeamBudget.mockReset();
  revokeTeamKey.mockReset();
});

afterEach(() => cleanup());

describe("a team's key made by Optio", () => {
  it("a team admin creates it with the budget typed, within the cap", async () => {
    createTeamKey.mockResolvedValue({
      action: "issue",
      key: issued,
      secretName: "ANTHROPIC_AUTH_TOKEN",
      test: { ok: true, modelCount: 2 },
      budget: {
        spend: 0,
        maxBudget: 20,
        budgetDuration: "7d",
        budgetResetAt: null,
        source: "gateway",
      },
    });
    const onChanged = vi.fn();
    render(<TeamGatewayKey teamKey={teamKey()} onChanged={onChanged} />);
    expect(screen.getByText(/A team admin may set up to \$50\.00/)).toBeInTheDocument();
    const amount = screen.getByLabelText("Team budget in USD") as HTMLInputElement;
    expect(amount.value).toBe("50");
    fireEvent.change(amount, { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Team budget period"), { target: { value: "7d" } });
    fireEvent.click(screen.getByTestId("create-team-key"));
    await waitFor(() =>
      expect(createTeamKey).toHaveBeenCalledWith("t1", { maxBudget: 20, budgetDuration: "7d" }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("refuses an amount that isn't one before asking the API", async () => {
    render(<TeamGatewayKey teamKey={teamKey()} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Team budget in USD"), { target: { value: "lots" } });
    fireEvent.click(screen.getByTestId("create-team-key"));
    await waitFor(() => expect(createTeamKey).not.toHaveBeenCalled());
  });

  it("shows the budget spent, and sets a new one", async () => {
    setTeamBudget.mockResolvedValue({ budget: {} });
    render(
      <TeamGatewayKey
        teamKey={teamKey({
          issued,
          hasToken: true,
          budget: {
            spend: 42,
            maxBudget: 50,
            budgetDuration: "30d",
            budgetResetAt: null,
            source: "gateway",
          },
        })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByTestId("team-issued-key")).toHaveTextContent("optio-team-platform");
    expect(screen.getByTestId("team-budget")).toHaveTextContent("$42.00 of $50.00 per 30d spent");
    // 84%: the bar turns amber.
    expect(screen.getByTestId("team-budget").querySelector(".bg-warning")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Team budget in USD"), { target: { value: "45" } });
    fireEvent.click(screen.getByTestId("set-team-budget"));
    await waitFor(() =>
      expect(setTeamBudget).toHaveBeenCalledWith("t1", { maxBudget: 45, budgetDuration: "30d" }),
    );
  });

  it("revokes after a confirmation", async () => {
    revokeTeamKey.mockResolvedValue({ revoked: 1 });
    render(<TeamGatewayKey teamKey={teamKey({ issued, hasToken: true })} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));
    expect(screen.getByText("Revoke the team's key?")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" }).at(-1)!);
    await waitFor(() => expect(revokeTeamKey).toHaveBeenCalledWith("t1"));
  });

  it("a member reads the budget and changes nothing; nothing at all when Optio makes no keys", () => {
    const { container, unmount } = render(
      <TeamGatewayKey teamKey={teamKey({ canManage: false })} onChanged={vi.fn()} />,
    );
    expect(container.textContent).toBe("");
    unmount();
    render(
      <TeamGatewayKey
        teamKey={teamKey({
          canManage: false,
          issued,
          budget: {
            spend: 1,
            maxBudget: 50,
            budgetDuration: "30d",
            budgetResetAt: null,
            source: "saved",
          },
        })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("team-budget")).toHaveTextContent("(at Optio's last check)");
    cleanup();
    const off = render(
      <TeamGatewayKey
        teamKey={teamKey({ modes: { personalPasted: true, optioIssued: false } })}
        onChanged={vi.fn()}
      />,
    );
    expect(off.container.textContent).toBe("");
  });

  it("the members' card shows the budget only when Optio made the key", async () => {
    getTeamKey.mockResolvedValueOnce(teamKey({ canManage: false }));
    const first = render(<TeamGatewayBudgetCard teamId="t1" />);
    await waitFor(() => expect(getTeamKey).toHaveBeenCalledWith("t1"));
    expect(first.container.textContent).toBe("");
    first.unmount();
    getTeamKey.mockResolvedValueOnce(
      teamKey({
        canManage: false,
        issued,
        budget: {
          spend: 50,
          maxBudget: 50,
          budgetDuration: "30d",
          budgetResetAt: null,
          source: "gateway",
        },
      }),
    );
    render(<TeamGatewayBudgetCard teamId="t1" />);
    expect(await screen.findByText("Gateway budget")).toBeInTheDocument();
    // Spent: the bar turns red.
    expect(screen.getByTestId("team-budget").querySelector(".bg-error")).not.toBeNull();
  });
});
