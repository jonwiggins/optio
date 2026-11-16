import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { csvCell, reportRange, reportToCsv } from "../services/usage-report-service.js";

const mockIsDeploymentAdmin = vi.fn();
vi.mock("../services/sign-in-config-service.js", () => ({
  isDeploymentAdmin: (...args: unknown[]) => mockIsDeploymentAdmin(...args),
  hasDeploymentAdmin: vi.fn().mockResolvedValue(true),
  isFoundingWorkspaceAdmin: vi.fn().mockResolvedValue(false),
}));

const mockExecute = vi.fn();
vi.mock("../db/client.js", () => ({ db: { execute: (...a: unknown[]) => mockExecute(...a) } }));

const mockLogAction = vi.fn();
vi.mock("../services/optio-action-service.js", () => ({
  logAction: (...a: unknown[]) => mockLogAction(...a),
}));

import { usageRoutes } from "./usage.js";

const ledgerRow = (key: string | null, name: string, cost: string | null) => ({
  key,
  name,
  tokens: "1200",
  input_tokens: "1000",
  output_tokens: "200",
  cached_tokens: "0",
  cost_usd: cost,
  reported_cost_usd: cost,
  estimated_cost_usd: null,
  runs: "2",
  completed_runs: "1",
  unpriced_runs: cost === null ? "2" : "0",
  unmeasured_runs: "0",
  historical_runs: "0",
  retry_cost_usd: "0",
});

describe("deployment usage report routes", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.OPTIO_AUTH_DISABLED;
    mockIsDeploymentAdmin.mockResolvedValue(true);
    mockLogAction.mockResolvedValue({});
    mockExecute.mockImplementation(async (q: unknown) => {
      const text = JSON.stringify(q);
      return text.includes("GROUP BY")
        ? [ledgerRow("ws-a", '=HYPERLINK("x")', "1.5"), ledgerRow(null, "No workspace", null)]
        : [ledgerRow(null, "", "1.5")];
    });
    app = await buildRouteTestApp(usageRoutes);
  });

  it("refuses a workspace admin who is not a deployment admin, for JSON and CSV", async () => {
    mockIsDeploymentAdmin.mockResolvedValue(false);
    for (const url of ["/api/admin/usage/report", "/api/admin/usage/report.csv"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(403);
    }
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockLogAction).not.toHaveBeenCalled();
  });

  it("serves a deployment admin who is only a member of the workspace they're in", async () => {
    const member = await buildRouteTestApp(usageRoutes, {
      user: { id: "user-2", workspaceId: "ws-1", workspaceRole: "member" },
    });
    const res = await member.inject({
      method: "GET",
      url: "/api/admin/usage/report?from=2026-01-01&to=2026-03-31&groupBy=workspace",
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns grouped totals as JSON without logging an export", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/usage/report?from=2026-01-01&to=2026-03-31&groupBy=workspace",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ from: "2026-01-01", to: "2026-03-31", groupBy: "workspace" });
    expect(body.totals.costUsd).toBe("1.5");
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toMatchObject({ key: "ws-a", runs: 2, tokens: 1200 });
    expect(body.truncated).toBe(false);
    expect(mockLogAction).not.toHaveBeenCalled();
  });

  it("sends CSV as an attachment and records the export first", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/usage/report.csv?from=2026-01-01&to=2026-01-31&groupBy=person",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="optio-usage-person-2026-01-01-2026-01-31.csv"',
    );
    expect(res.headers["cache-control"]).toBe("no-store");
    const lines = res.body.split("\r\n");
    expect(lines[0]).toBe(
      "key,name,runs,completed_runs,tokens,input_tokens,output_tokens,cached_input_tokens," +
        "cost_usd,reported_cost_usd,estimated_cost_usd,unpriced_runs",
    );
    expect(lines[1]).toBe(`ws-a,"'=HYPERLINK(""x"")",2,1,1200,1000,200,0,1.5,1.5,,0`);
    expect(lines[2]).toBe(",No workspace,2,1,1200,1000,200,0,,,,2");
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "usage.export",
        userId: "user-1",
        workspaceId: null,
        success: true,
        result: expect.objectContaining({ from: "2026-01-01", to: "2026-01-31", count: 2 }),
      }),
    );
  });

  it("sends nothing when the export cannot be recorded", async () => {
    mockLogAction.mockRejectedValue(new Error("db down"));
    const res = await app.inject({ method: "GET", url: "/api/admin/usage/report.csv" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("HYPERLINK");
  });

  it.each([
    ["from=2026-02-30", "not a real date"],
    ["from=2026/01/01", "not ISO"],
    ["to=20260101", "not ISO"],
    ["groupBy=team", "unknown grouping"],
    ["workspaceId=not-a-uuid", "not a uuid"],
  ])("rejects %s (%s)", async (qs) => {
    const res = await app.inject({ method: "GET", url: `/api/admin/usage/report?${qs}` });
    expect(res.statusCode).toBe(400);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it.each([
    ["from=2026-03-02&to=2026-03-01", "on or before"],
    ["from=2025-01-01&to=2026-01-02", "at most 366 days"],
  ])("rejects the range %s", async (qs, message) => {
    for (const path of ["report", "report.csv"]) {
      const res = await app.inject({ method: "GET", url: `/api/admin/usage/${path}?${qs}` });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain(message);
    }
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockLogAction).not.toHaveBeenCalled();
  });
});

describe("reportRange", () => {
  const now = new Date("2026-05-17T15:00:00Z");
  it("defaults to this UTC month up to today", () => {
    expect(reportRange({}, now)).toMatchObject({
      from: "2026-05-01",
      to: "2026-05-17",
      start: new Date("2026-05-01T00:00:00Z"),
      end: new Date("2026-05-18T00:00:00Z"),
    });
  });
  it("includes the whole last day and allows one leap year", () => {
    expect(reportRange({ from: "2024-01-01", to: "2024-12-31" }, now)).toMatchObject({
      end: new Date("2025-01-01T00:00:00Z"),
    });
    expect(reportRange({ from: "2026-05-17", to: "2026-05-17" }, now)).not.toHaveProperty("error");
  });
});

describe("csvCell", () => {
  it.each([
    ["=1+1", "'=1+1"],
    ["+cmd", "'+cmd"],
    ["-2", "'-2"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tx", "'\tx"],
    ["\rx", '"\'\rx"'],
    ['say "hi"', '"say ""hi"""'],
    ["a,b", '"a,b"'],
    ["line\nbreak", '"line\nbreak"'],
    ["https://git.example.com/a/b", "https://git.example.com/a/b"],
  ])("writes %j as %j", (input, out) => {
    expect(csvCell(input)).toBe(out);
  });
  it("leaves numbers and amounts alone and writes null as empty", () => {
    expect(csvCell(12)).toBe("12");
    expect(csvCell("0.125", false)).toBe("0.125");
    expect(csvCell(null)).toBe("");
  });
  it("writes a header-only file for an empty report", () => {
    const csv = reportToCsv({
      from: "2026-01-01",
      to: "2026-01-01",
      groupBy: "model",
      totals: {} as never,
      rows: [],
      truncated: false,
    });
    expect(csv.split("\r\n")).toHaveLength(2);
  });
});
