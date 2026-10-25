import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoIdentifier } from "@optio/shared";
import { fetchFailedJobLogs, maskSecrets, tailOfLog } from "./gitlab-ci-logs.js";

const ri: RepoIdentifier = {
  platform: "gitlab",
  host: "gitlab.example.com",
  owner: "platform",
  repo: "my.service",
  apiBaseUrl: "https://gitlab.example.com/api/v4",
};
const PROJECT = "https://gitlab.example.com/api/v4/projects/platform%2Fmy.service";

describe("tailOfLog", () => {
  it("keeps the last lines", () => {
    const log = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n");
    const tail = tailOfLog(log, 150).split("\n");
    expect(tail).toHaveLength(150);
    expect(tail[0]).toBe("line 251");
    expect(tail[149]).toBe("line 400");
  });

  it("removes GitLab's section markers, colours and progress redraws", () => {
    const raw =
      "\x1b[0Ksection_start:1700000000:step_script\r\x1b[0K\x1b[0K\x1b[36;1mExecuting step_script\x1b[0;m\n" +
      "Downloading 10%\rDownloading 50%\rDownloading 100%\n" +
      "\x1b[31;1mE2E_FAIL_MARKER\x1b[0;m\n" +
      "\x1b[0Ksection_end:1700000001:step_script\r\x1b[0K\n" +
      "\x1b[31;1mERROR: Job failed: exit code 1\x1b[0;m\n\n\n";
    expect(tailOfLog(raw, 150)).toBe(
      [
        "Executing step_script",
        "Downloading 100%",
        "E2E_FAIL_MARKER",
        "",
        "ERROR: Job failed: exit code 1",
      ].join("\n"),
    );
  });

  it("cuts very long lines", () => {
    const tail = tailOfLog("x".repeat(2_000), 10);
    expect(tail.length).toBeLessThan(510);
    expect(tail.endsWith("…")).toBe(true);
  });
});

describe("maskSecrets", () => {
  it("masks token shapes", () => {
    const text = [
      "using glpat-" + "abcdefghijklmnopqrstu",
      "runner glrt-ABCDEFGHIJKLMNOPQRSTUV",
      "key sk-proj-" + "abcdefghijklmnop1234",
      "aws AKIA" + "ABCDEFGHIJKLMNOP",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
      "clone https://deploy:s3cr3tvalue@gitlab.example.com/a/b.git",
      "Authorization: Bearer abc.def.ghi",
      "PRIVATE-TOKEN: zzzzzzzzzzzz",
    ].join("\n");
    const masked = maskSecrets(text);
    for (const leak of [
      "glpat-abc",
      "glrt-ABC",
      "sk-proj",
      "AKIAABCD",
      "eyJhbGci",
      "s3cr3tvalue",
      "abc.def.ghi",
      "zzzzzzzzzzzz",
    ]) {
      expect(masked).not.toContain(leak);
    }
    expect(masked).toContain("https://[MASKED]@gitlab.example.com/a/b.git");
  });

  it("masks values named like secrets", () => {
    const masked = maskSecrets(
      'DB_PASSWORD=hunter2hunter\napi_key: "abcdef123"\nexport GITLAB_TOKEN=whatever-value',
    );
    expect(masked).toBe("DB_PASSWORD=[MASKED]\napi_key: [MASKED]\nexport GITLAB_TOKEN=[MASKED]");
  });

  it("masks a private key block", () => {
    const masked = maskSecrets(
      "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3Nza\n-----END OPENSSH PRIVATE KEY-----\nnext",
    );
    expect(masked).toBe("[MASKED PRIVATE KEY]\nnext");
  });

  it("masks known values", () => {
    expect(maskSecrets("token is plainvalue123 here", ["plainvalue123"])).toBe(
      "token is [MASKED] here",
    );
  });

  it("leaves ordinary build errors readable", () => {
    const errors = [
      "SyntaxError: Unexpected token '}'",
      "src/a.ts(3,1): error TS1005: ';' expected.",
      "npm ERR! code ELIFECYCLE",
      "AssertionError: expected 2 to equal 3",
      "global-agent installed",
    ].join("\n");
    expect(maskSecrets(errors)).toBe(errors);
  });
});

describe("fetchFailedJobLogs", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubGitLab(routes: Record<string, () => Response>) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(url);
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          "Bearer glpat-testtoken12345678",
        );
        const route = routes[url];
        return route ? route() : new Response("not found", { status: 404 });
      }),
    );
    return calls;
  }
  const json = (body: unknown) => () => Response.json(body);

  it("reads the failed jobs of the head commit's newest pipeline, blocking jobs first", async () => {
    const calls = stubGitLab({
      [`${PROJECT}/pipelines?sha=abc123&per_page=1`]: json([
        { id: 77, web_url: "https://gitlab.example.com/platform/my.service/-/pipelines/77" },
      ]),
      [`${PROJECT}/pipelines/77/jobs?scope[]=failed&per_page=100`]: json([
        { id: 1, name: "lint", stage: "test", allow_failure: true },
        { id: 2, name: "unit", stage: "test", web_url: "https://gitlab.example.com/j/2" },
      ]),
      [`${PROJECT}/jobs/2/trace`]: () =>
        new Response("setup\nE2E_FAIL_MARKER token=glpat-testtoken12345678\nexit 1\n"),
    });

    const out = await fetchFailedJobLogs(ri, "glpat-testtoken12345678", "abc123");

    expect(out).toEqual({
      pipelineId: 77,
      pipelineUrl: "https://gitlab.example.com/platform/my.service/-/pipelines/77",
      jobs: [
        {
          id: 2,
          name: "unit",
          stage: "test",
          webUrl: "https://gitlab.example.com/j/2",
          tail: "setup\nE2E_FAIL_MARKER token=[MASKED]\nexit 1",
        },
      ],
      more: [],
    });
    // The job allowed to fail isn't read.
    expect(calls).not.toContain(`${PROJECT}/jobs/1/trace`);
  });

  it("reads the MR's head pipeline (merged results run on another SHA) when given the MR", async () => {
    const calls = stubGitLab({
      [`${PROJECT}/merge_requests/12`]: json({
        sha: "abc123",
        head_pipeline: { id: 91, web_url: "https://gitlab.example.com/p/91" },
      }),
      [`${PROJECT}/pipelines/91/jobs?scope[]=failed&per_page=100`]: json([
        { id: 5, name: "unit", stage: "test" },
      ]),
      [`${PROJECT}/jobs/5/trace`]: () => new Response("boom\n"),
    });

    const out = await fetchFailedJobLogs(ri, "glpat-testtoken12345678", "abc123", { mrIid: 12 });

    expect(out?.pipelineId).toBe(91);
    expect(calls.some((c) => c.includes("/pipelines?sha="))).toBe(false);
  });

  it("falls back to the SHA's newest pipeline when the MR moved on or has none", async () => {
    const calls = stubGitLab({
      [`${PROJECT}/merge_requests/12`]: json({ sha: "newer", head_pipeline: { id: 91 } }),
      [`${PROJECT}/pipelines?sha=abc123&per_page=1`]: json([{ id: 77 }]),
      [`${PROJECT}/pipelines/77/jobs?scope[]=failed&per_page=100`]: json([]),
    });

    expect(await fetchFailedJobLogs(ri, "glpat-testtoken12345678", "abc123", { mrIid: 12 })).toBe(
      null,
    );
    expect(calls).toContain(`${PROJECT}/pipelines?sha=abc123&per_page=1`);
  });

  it("includes logs for the first jobs and names the rest", async () => {
    const jobs = Array.from({ length: 7 }, (_, i) => ({
      id: i + 1,
      name: `j${i + 1}`,
      stage: "s",
    }));
    const routes: Record<string, () => Response> = {
      [`${PROJECT}/pipelines?sha=abc&per_page=1`]: json([{ id: 5 }]),
      [`${PROJECT}/pipelines/5/jobs?scope[]=failed&per_page=100`]: json(jobs),
    };
    for (const j of jobs)
      routes[`${PROJECT}/jobs/${j.id}/trace`] = () => new Response(`log ${j.id}`);
    stubGitLab(routes);

    const out = await fetchFailedJobLogs(ri, "glpat-testtoken12345678", "abc");

    expect(out?.jobs.map((j) => j.tail)).toEqual(["log 1", "log 2", "log 3", "log 4", "log 5"]);
    expect(out?.more).toEqual([
      { name: "j6", stage: "s" },
      { name: "j7", stage: "s" },
    ]);
  });

  it("keeps a job whose log can't be read, without its log", async () => {
    stubGitLab({
      [`${PROJECT}/pipelines?sha=abc&per_page=1`]: json([{ id: 5 }]),
      [`${PROJECT}/pipelines/5/jobs?scope[]=failed&per_page=100`]: json([
        { id: 9, name: "build", stage: "build" },
      ]),
    });
    const out = await fetchFailedJobLogs(ri, "glpat-testtoken12345678", "abc");
    expect(out?.jobs).toEqual([{ id: 9, name: "build", stage: "build", tail: "" }]);
  });

  it("answers null without a pipeline or a failed job", async () => {
    stubGitLab({ [`${PROJECT}/pipelines?sha=abc&per_page=1`]: json([]) });
    expect(await fetchFailedJobLogs(ri, "glpat-testtoken12345678", "abc")).toBeNull();

    stubGitLab({
      [`${PROJECT}/pipelines?sha=abc&per_page=1`]: json([{ id: 5 }]),
      [`${PROJECT}/pipelines/5/jobs?scope[]=failed&per_page=100`]: json([]),
    });
    expect(await fetchFailedJobLogs(ri, "glpat-testtoken12345678", "abc")).toBeNull();
  });

  it("throws when GitLab refuses the pipeline list", async () => {
    stubGitLab({});
    await expect(fetchFailedJobLogs(ri, "glpat-testtoken12345678", "abc")).rejects.toThrow(
      "GitLab API error 404",
    );
  });

  it("reads only the end of a very long log", async () => {
    const long = `${"noise\n".repeat(200_000)}the real error\n`;
    stubGitLab({
      [`${PROJECT}/pipelines?sha=abc&per_page=1`]: json([{ id: 5 }]),
      [`${PROJECT}/pipelines/5/jobs?scope[]=failed&per_page=100`]: json([
        { id: 9, name: "build", stage: "build" },
      ]),
      [`${PROJECT}/jobs/9/trace`]: () => new Response(long),
    });
    const out = await fetchFailedJobLogs(ri, "glpat-testtoken12345678", "abc");
    const lines = out!.jobs[0].tail.split("\n");
    expect(lines).toHaveLength(150);
    expect(lines[149]).toBe("the real error");
  });
});
