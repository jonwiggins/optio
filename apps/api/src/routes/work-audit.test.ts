/**
 * Saving work from the Work form records automatic merging turned on with
 * the dialog (`auto_merge.confirm`) or turned off (`auto_merge.off`) in the
 * audit trail (docs/audit.md), like repos and scheduled Tasks do.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

vi.mock("../services/work-service.js", () => ({
  listWork: vi.fn(),
  resolveWork: vi.fn(),
}));
const mockUpdateWork = vi.fn();
const mockGetOwnDefinition = vi.fn();
vi.mock("../services/work-write-service.js", () => ({
  WorkError: class WorkError extends Error {},
  createWork: vi.fn(),
  updateWork: (...args: unknown[]) => mockUpdateWork(...args),
  deleteWork: vi.fn(),
  getOwnDefinition: (...args: unknown[]) => mockGetOwnDefinition(...args),
}));
const logAction = vi.hoisted(() => vi.fn());
vi.mock("../services/optio-action-service.js", () => ({ logAction }));

import { workRoutes } from "./work.js";

const spec = (then: string, extra: Record<string, unknown> = {}) => ({
  name: "Nightly",
  when: { type: "schedule", config: { cronExpression: "0 9 * * *" } },
  where: { runTarget: "cluster" },
  who: { runtime: "claude-code" },
  what: { prompt: "go" },
  then,
  ...extra,
});

/** The audit entries written (auditEvent goes through logAction), waiting a moment for them. */
async function audited(): Promise<{ action: string; params: unknown }[]> {
  await new Promise((r) => setTimeout(r, 10));
  return logAction.mock.calls
    .map((c) => c[0] as { action: string; params: unknown })
    .filter((e) => e.action.startsWith("auto_merge."));
}

describe("PATCH /api/work/:id and automatic merging", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    logAction.mockResolvedValue({});
    mockUpdateWork.mockResolvedValue({ kind: "repo-blueprint", id: "w1", href: "/x" });
    app = await buildRouteTestApp(workRoutes);
  });

  it("records turning it off on a definition that merged by itself", async () => {
    mockGetOwnDefinition.mockResolvedValue({ id: "w1", autoMerge: true });
    const res = await app.inject({
      method: "PATCH",
      url: "/api/work/w1",
      payload: spec("until-merged", { mergeWhenReady: false }),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await audited()).toEqual([
      expect.objectContaining({ action: "auto_merge.off", params: { type: "work", id: "w1" } }),
    ]);
  });

  it("records it off when the edit moves away from works-until-merged", async () => {
    mockGetOwnDefinition.mockResolvedValue({ id: "w1", autoMerge: true });
    await app.inject({ method: "PATCH", url: "/api/work/w1", payload: spec("exits") });
    expect((await audited()).map((e) => e.action)).toEqual(["auto_merge.off"]);
  });

  it("records nothing for a definition that didn't merge by itself, or one it can't read", async () => {
    mockGetOwnDefinition.mockResolvedValueOnce({ id: "w1", autoMerge: false });
    await app.inject({ method: "PATCH", url: "/api/work/w1", payload: spec("exits") });
    mockGetOwnDefinition.mockRejectedValueOnce(new Error("db down"));
    const res = await app.inject({ method: "PATCH", url: "/api/work/w1", payload: spec("exits") });
    expect(res.statusCode).toBe(200);
    expect(await audited()).toEqual([]);
  });

  it("records a confirmation", async () => {
    mockGetOwnDefinition.mockResolvedValue({ id: "w1", autoMerge: false });
    await app.inject({
      method: "PATCH",
      url: "/api/work/w1",
      payload: spec("until-merged", { mergeWhenReady: true, autoMergeConfirmed: true }),
    });
    expect((await audited()).map((e) => e.action)).toEqual(["auto_merge.confirm"]);
  });
});
