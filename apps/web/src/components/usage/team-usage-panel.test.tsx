import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// The Usage page's team breakdown: team work charged to its team.

const getTeamUsage = vi.fn();
vi.mock("@/lib/gateway-keys-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/gateway-keys-api")>()),
  gatewayKeysApi: { getTeamUsage: (...a: unknown[]) => getTeamUsage(...a) },
}));

import { TeamUsagePanel } from "./team-usage-panel";

beforeEach(() => {
  getTeamUsage.mockReset();
});
afterEach(() => cleanup());

describe("TeamUsagePanel", () => {
  it("lists each team's tokens, cost and runs, with its gateway budget", async () => {
    getTeamUsage.mockResolvedValue({
      start: "2026-09-25T00:00:00.000Z",
      end: "2026-10-24T00:00:00.000Z",
      teams: [
        {
          teamId: "t1",
          name: "Platform",
          tokens: 12000,
          costUsd: "1.50",
          runs: 3,
          gatewayBudget: {
            spend: 1.5,
            maxBudget: 10,
            budgetDuration: "30d",
            budgetResetAt: null,
            source: "gateway",
          },
        },
        { teamId: "t2", name: "Data", tokens: 0, costUsd: null, runs: 0, gatewayBudget: null },
      ],
    });
    render(<TeamUsagePanel days={30} />);
    const panel = await screen.findByTestId("team-usage");
    expect(getTeamUsage).toHaveBeenCalledWith(30);
    expect(panel).toHaveTextContent("Platform");
    expect(panel).toHaveTextContent("3 runs");
    expect(panel).toHaveTextContent("$1.50 of $10.00 per 30d spent");
    expect(panel).toHaveTextContent("Data");
    expect(panel).toHaveTextContent("cost not reported");
    expect(screen.getByRole("link", { name: "Platform" })).toHaveAttribute("href", "/teams/t1");
  });

  it("shows nothing to someone in no team", async () => {
    getTeamUsage.mockResolvedValue({ start: "", end: "", teams: [] });
    const { container } = render(<TeamUsagePanel days={7} />);
    await waitFor(() => expect(getTeamUsage).toHaveBeenCalledWith(7));
    expect(container.textContent).toBe("");
  });

  it("shows nothing when the API refuses", async () => {
    getTeamUsage.mockImplementation(() => Promise.reject(new Error("403")));
    const { container } = render(<TeamUsagePanel days={7} />);
    await waitFor(() => expect(getTeamUsage).toHaveBeenCalledTimes(1));
    expect(container.textContent).toBe("");
  });
});
