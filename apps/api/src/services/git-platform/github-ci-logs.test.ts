import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoIdentifier } from "@optio/shared";
import { cleanGitHubLog, fetchFailedGitHubJobLogs } from "./github-ci-logs.js";

const ri: RepoIdentifier = {
  platform: "github",
  host: "github.com",
  owner: "acme",
  repo: "app",
  apiBaseUrl: "https://api.github.com",
};
const REPO = "https://api.github.com/repos/acme/app";

describe("cleanGitHubLog", () => {
  it("drops timestamps and group markers, keeps errors readable", () => {
    const raw = [
      "2026-10-01T10:00:00.1234567Z ##[group]Run pnpm test",
      "2026-10-01T10:00:01.0000000Z pnpm test",
      "2026-10-01T10:00:02.0000000Z ##[endgroup]",
      "2026-10-01T10:00:03.0000000Z FAIL src/a.test.ts",
      "2026-10-01T10:00:04.0000000Z ##[error]Process completed with exit code 1.",
    ].join("\n");
    expect(cleanGitHubLog(raw)).toBe(
      [
        "Run pnpm test",
        "pnpm test",
        "",
        "FAIL src/a.test.ts",
        "error: Process completed with exit code 1.",
      ].join("\n"),
    );
  });
});

describe("fetchFailedGitHubJobLogs", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubGitHub(routes: Record<string, () => Response>) {
    const calls: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({ url, auth: headers.get("authorization") });
        const route = Object.keys(routes).find((k) => url.startsWith(k));
        return route ? routes[route]() : new Response("not found", { status: 404 });
      }),
    );
    return calls;
  }

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

  it("reads the failed jobs of the newest failed run of each workflow, logs fetched without the token", async () => {
    const calls = stubGitHub({
      [`${REPO}/actions/runs?head_sha=abc`]: () =>
        json({
          workflow_runs: [
            {
              id: 10,
              name: "CI",
              workflow_id: 1,
              conclusion: "failure",
              html_url: "https://github.com/acme/app/actions/runs/10",
              created_at: "2026-10-01T10:00:00Z",
            },
            // An older attempt of the same workflow: not what the checks show.
            {
              id: 9,
              name: "CI",
              workflow_id: 1,
              conclusion: "failure",
              created_at: "2026-10-01T09:00:00Z",
            },
            { id: 11, name: "Lint", workflow_id: 2, conclusion: "success" },
          ],
        }),
      [`${REPO}/actions/runs/10/jobs`]: () =>
        json({
          jobs: [
            { id: 100, name: "unit", conclusion: "failure", html_url: "https://github.com/j/100" },
            { id: 101, name: "build", conclusion: "success" },
          ],
        }),
      [`${REPO}/actions/jobs/100/logs`]: () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://results.example.test/logs/100?sig=x" },
        }),
      "https://results.example.test/logs/100": () =>
        new Response(
          "2026-10-01T10:00:03.0000000Z FAIL_MARKER token=ghp_abcdefghijklmnopqrstuvwxyz0123\n",
        ),
    });

    const failure = await fetchFailedGitHubJobLogs(ri, "ghs_secret_token_value", "abc");

    expect(failure).toEqual({
      pipelineId: 10,
      pipelineUrl: "https://github.com/acme/app/actions/runs/10",
      jobs: [
        {
          id: 100,
          name: "unit",
          stage: "CI",
          webUrl: "https://github.com/j/100",
          tail: "FAIL_MARKER token=[MASKED]",
        },
      ],
      more: [],
    });
    expect(calls.some((c) => c.url.startsWith(`${REPO}/actions/runs/9/`))).toBe(false);
    const download = calls.find((c) => c.url.startsWith("https://results.example.test/"))!;
    expect(download.auth).toBeNull();
    expect(calls.find((c) => c.url.startsWith(`${REPO}/actions/runs?`))!.auth).toBe(
      "Bearer ghs_secret_token_value",
    );
  });

  it("is null when no run failed", async () => {
    stubGitHub({
      [`${REPO}/actions/runs?head_sha=abc`]: () =>
        json({ workflow_runs: [{ id: 1, name: "CI", conclusion: "success" }] }),
    });
    expect(await fetchFailedGitHubJobLogs(ri, "t", "abc")).toBeNull();
  });

  it("keeps a job whose log can't be read, without a tail", async () => {
    stubGitHub({
      [`${REPO}/actions/runs?head_sha=abc`]: () =>
        json({ workflow_runs: [{ id: 5, name: "CI", conclusion: "timed_out" }] }),
      [`${REPO}/actions/runs/5/jobs`]: () =>
        json({ jobs: [{ id: 50, name: "e2e", conclusion: "timed_out" }] }),
      [`${REPO}/actions/jobs/50/logs`]: () => new Response("gone", { status: 410 }),
    });
    const failure = await fetchFailedGitHubJobLogs(ri, "t", "abc");
    expect(failure?.jobs).toEqual([{ id: 50, name: "e2e", stage: "CI", tail: "" }]);
  });

  it("throws on a refused API call (the caller falls back)", async () => {
    stubGitHub({ [`${REPO}/actions/runs?head_sha=abc`]: () => new Response("", { status: 403 }) });
    await expect(fetchFailedGitHubJobLogs(ri, "t", "abc")).rejects.toThrow(/GitHub API error 403/);
  });
});
