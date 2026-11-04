import { describe, expect, it, vi } from "vitest";
import type { RepoIdentifier } from "@optio/shared";
import { PrQuickActionError, rerunFailedChecks, updatePrBranch } from "./pr-quick-actions.js";

const gh: RepoIdentifier = {
  platform: "github",
  host: "github.com",
  owner: "acme",
  repo: "app",
  apiBaseUrl: "https://api.github.com",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("updatePrBranch (GitHub)", () => {
  it("PUTs update-branch with the head the page saw", async () => {
    const f = vi.fn().mockResolvedValue(json({ message: "Updating" }, 202));
    await updatePrBranch(gh, "tok", 7, "abc123", f as typeof fetch);
    expect(f.mock.calls[0][0]).toBe("https://api.github.com/repos/acme/app/pulls/7/update-branch");
    expect(f.mock.calls[0][1].method).toBe("PUT");
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ expected_head_sha: "abc123" });
  });

  it("says why GitHub refused (conflicts / moved head) as a 409", async () => {
    const conflict = vi
      .fn()
      .mockResolvedValue(json({ message: "merge conflict between base and head" }, 422));
    await expect(updatePrBranch(gh, "t", 7, null, conflict as typeof fetch)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("conflicts"),
    });
    const moved = vi
      .fn()
      .mockResolvedValue(json({ message: "expected head sha didn't match" }, 422));
    await expect(updatePrBranch(gh, "t", 7, "x", moved as typeof fetch)).rejects.toBeInstanceOf(
      PrQuickActionError,
    );
  });
});

describe("rerunFailedChecks (GitHub)", () => {
  it("re-runs the failed jobs of every failed Actions run on the head", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          workflow_runs: [
            { id: 1, conclusion: "failure" },
            { id: 2, conclusion: "success" },
            { id: 3, conclusion: "timed_out" },
          ],
        }),
      )
      .mockResolvedValue(new Response(null, { status: 201 }));
    expect(await rerunFailedChecks(gh, "t", 7, "sha1", f as typeof fetch)).toBe(2);
    expect(f.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/acme/app/actions/runs?head_sha=sha1&per_page=50",
    );
    expect(f.mock.calls.slice(1).map((c) => [c[0], c[1].method])).toEqual([
      ["https://api.github.com/repos/acme/app/actions/runs/1/rerun-failed-jobs", "POST"],
      ["https://api.github.com/repos/acme/app/actions/runs/3/rerun-failed-jobs", "POST"],
    ]);
  });

  it("nothing failed in Actions → a 404 that says so", async () => {
    const f = vi
      .fn()
      .mockResolvedValue(json({ workflow_runs: [{ id: 1, conclusion: "success" }] }));
    await expect(rerunFailedChecks(gh, "t", 7, "s", f as typeof fetch)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("other platforms", () => {
  it("CodeCommit can't do either", async () => {
    const cc = { ...gh, platform: "codecommit" as const };
    await expect(updatePrBranch(cc, "t", 1)).rejects.toBeInstanceOf(PrQuickActionError);
    await expect(rerunFailedChecks(cc, "t", 1, "s")).rejects.toBeInstanceOf(PrQuickActionError);
  });
});
