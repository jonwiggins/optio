import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const getReport = vi.fn();
const downloadReport = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    getDeploymentUsageReport: (...a: unknown[]) => getReport(...a),
    downloadDeploymentUsageReport: (...a: unknown[]) => downloadReport(...a),
  },
}));

import { DeploymentUsageReportPanel } from "./deployment-report";

const metrics = (costUsd: string | null, runs: number, tokens: number) => ({
  tokens,
  inputTokens: tokens,
  outputTokens: 0,
  cachedTokens: 0,
  costUsd,
  reportedCostUsd: costUsd,
  estimatedCostUsd: null,
  runs,
  completedRuns: runs,
  unpricedRuns: 0,
  unmeasuredRuns: 0,
  historicalRuns: 0,
  retryCostUsd: "0",
});

describe("DeploymentUsageReportPanel", () => {
  beforeEach(() => {
    getReport.mockImplementation(async (q: { from: string; to: string; groupBy: string }) => ({
      ...q,
      totals: metrics("3.5", 3, 3000),
      rows: [
        { key: "ws-a", name: "Team A", ...metrics("2.5", 2, 2000) },
        { key: "ws-b", name: "Team B", ...metrics("1", 1, 1000) },
      ],
      truncated: false,
    }));
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads this month by workspace and shows rows and the total", async () => {
    render(<DeploymentUsageReportPanel />);
    expect(await screen.findByText("Team A")).toBeInTheDocument();
    expect(screen.getByText("Team B")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    const q = getReport.mock.calls[0][0];
    expect(q.groupBy).toBe("workspace");
    expect(q.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(q.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("regroups by month and follows the date range", async () => {
    render(<DeploymentUsageReportPanel />);
    await screen.findByText("Team A");
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    await waitFor(() =>
      expect(getReport).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: "month" })),
    );
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-01" } });
    await waitFor(() =>
      expect(getReport).toHaveBeenLastCalledWith(
        expect.objectContaining({ groupBy: "month", from: "2026-01-01" }),
      ),
    );
  });

  it("downloads the CSV for the current selection", async () => {
    downloadReport.mockResolvedValue(new Blob(["key,name\r\n"], { type: "text/csv" }));
    const createObjectURL = vi.fn(() => "blob:report");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<DeploymentUsageReportPanel />);
    await screen.findByText("Team A");
    fireEvent.click(screen.getByRole("button", { name: /Download CSV/ }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(downloadReport).toHaveBeenCalledWith(expect.objectContaining({ groupBy: "workspace" }));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:report");
    click.mockRestore();
  });

  it("shows the server's refusal", async () => {
    getReport.mockRejectedValue(new Error("Forbidden: requires a deployment admin"));
    render(<DeploymentUsageReportPanel />);
    expect(await screen.findByText(/requires a deployment admin/)).toBeInTheDocument();
  });
});
