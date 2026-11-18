/**
 * Jenkins as an event source: a build notification (the Notification
 * plugin's JSON, or the flat shape a Jenkinsfile `post` step sends) →
 * normalize → match → params → firing, as pure functions.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("./trigger-dispatch.js", () => ({ fireTrigger: vi.fn() }));

import {
  firingFor,
  jenkinsBranch,
  jenkinsDeliveryKey,
  jenkinsEventParams,
  jenkinsJobFromUrl,
  jenkinsKindOf,
  matchJenkinsTrigger,
  normalizeJenkinsEvent,
} from "./event-trigger-service.js";

/** What the Notification plugin posts for a finished multibranch build. */
const PLUGIN_FAILED = {
  name: "main",
  display_name: "main",
  url: "job/platform/job/api/job/main/",
  build: {
    full_url: "https://jenkins.example.com/job/platform/job/api/job/main/42/",
    number: 42,
    phase: "COMPLETED",
    status: "FAILURE",
    url: "job/platform/job/api/job/main/42/",
    duration: 61234,
    scm: {
      url: "https://gitlab.example.com/platform/api.git",
      branch: "origin/main",
      commit: "0123456789abcdef0123456789abcdef01234567",
    },
    parameters: { DEPLOY: "false" },
    log: [
      "[Pipeline] sh",
      "+ npm test",
      "FAIL src/app.test.ts",
      "token=glpat-aaaaaaaaaaaaaaaaaaaa",
    ],
  },
};

/** What the Jenkinsfile `post` step in docs/jenkins.md sends. */
const PIPELINE_UNSTABLE = {
  job: "platform/api/feature%2Flogin",
  number: "7",
  result: "UNSTABLE",
  url: "https://jenkins.example.com/job/platform/job/api/job/feature%252Flogin/7/",
  branch: "feature/login",
  commit: "abcdef0",
  repo: "https://github.com/acme/api.git",
  changeId: "",
};

describe("Jenkins: helpers", () => {
  it("reads a job's full name from its URL, as Jenkins names the job", () => {
    expect(jenkinsJobFromUrl("job/platform/job/api/job/main/")).toBe("platform/api/main");
    // A multibranch branch `feature/x` is the job `feature%2Fx`, encoded once more in URLs.
    expect(jenkinsJobFromUrl("https://ci.example.com/job/app/job/feature%252Fx/3/")).toBe(
      "app/feature%2Fx",
    );
    expect(jenkinsJobFromUrl("https://ci.example.com/view/all/")).toBe("");
  });

  it("strips remote and ref prefixes from a branch", () => {
    expect(jenkinsBranch("origin/main")).toBe("main");
    expect(jenkinsBranch("refs/heads/release/1.2")).toBe("release/1.2");
    expect(jenkinsBranch("remotes/origin/dev")).toBe("dev");
    expect(jenkinsBranch("feature/x")).toBe("feature/x");
  });

  it("maps phase and result to a kind, ignoring the queue", () => {
    expect(jenkinsKindOf("STARTED", null)).toBe("started");
    expect(jenkinsKindOf("QUEUED", null)).toBeNull();
    expect(jenkinsKindOf("COMPLETED", "SUCCESS")).toBe("succeeded");
    expect(jenkinsKindOf("FINALIZED", "FAILURE")).toBe("failed");
    expect(jenkinsKindOf(null, "UNSTABLE")).toBe("unstable");
    expect(jenkinsKindOf(null, "ABORTED")).toBe("aborted");
    expect(jenkinsKindOf(null, "NOT_BUILT")).toBe("not_built");
    expect(jenkinsKindOf("COMPLETED", null)).toBeNull();
  });
});

describe("Jenkins: normalize", () => {
  it("reads the Notification plugin's payload", () => {
    const ev = normalizeJenkinsEvent(PLUGIN_FAILED)!;
    expect(ev).toMatchObject({
      kind: "failed",
      job: "platform/api/main",
      jobName: "main",
      number: 42,
      url: "https://jenkins.example.com/job/platform/job/api/job/main/42/",
      phase: "COMPLETED",
      status: "FAILURE",
      branch: "main",
      commit: "0123456789abcdef0123456789abcdef01234567",
      repoUrl: "https://gitlab.example.com/platform/api.git",
      durationMs: 61234,
      parameters: { DEPLOY: "false" },
    });
    expect(ev.log).toContain("FAIL src/app.test.ts");
    // A token printed in the log doesn't reach the prompt.
    expect(ev.log).not.toContain("glpat-aaaaaaaaaaaaaaaaaaaa");
  });

  it("reads the flat shape of a Jenkinsfile post step", () => {
    const ev = normalizeJenkinsEvent(PIPELINE_UNSTABLE)!;
    expect(ev).toMatchObject({
      kind: "unstable",
      job: "platform/api/feature%2Flogin",
      jobName: "feature%2Flogin",
      number: 7,
      branch: "feature/login",
      commit: "abcdef0",
      repoUrl: "https://github.com/acme/api.git",
      changeId: null,
      log: "",
    });
  });

  it("takes a started build, and drops a payload that names no job or build", () => {
    const started = normalizeJenkinsEvent({
      ...PLUGIN_FAILED,
      build: { ...PLUGIN_FAILED.build, phase: "STARTED", status: undefined },
    });
    expect(started?.kind).toBe("started");
    expect(normalizeJenkinsEvent({ hello: "world" })).toBeNull();
    expect(normalizeJenkinsEvent("not json")).toBeNull();
  });
});

describe("Jenkins: match", () => {
  const failed = normalizeJenkinsEvent(PLUGIN_FAILED)!;

  it("fires on any finished build by default, never on a start", () => {
    expect(matchJenkinsTrigger({}, failed)).toBe("failed");
    const started = { ...failed, kind: "started" as const };
    expect(matchJenkinsTrigger({}, started)).toBeNull();
    expect(matchJenkinsTrigger({ events: ["started"] }, started)).toBe("started");
  });

  it("filters on the result", () => {
    expect(matchJenkinsTrigger({ events: ["failed", "unstable"] }, failed)).toBe("failed");
    expect(matchJenkinsTrigger({ events: ["succeeded"] }, failed)).toBeNull();
  });

  it("filters on jobs by full or short name, with * patterns, case-insensitively", () => {
    expect(matchJenkinsTrigger({ jobs: ["platform/api/main"] }, failed)).toBe("failed");
    expect(matchJenkinsTrigger({ jobs: ["MAIN"] }, failed)).toBe("failed");
    expect(matchJenkinsTrigger({ jobs: ["platform/api/*"] }, failed)).toBe("failed");
    expect(matchJenkinsTrigger({ jobs: ["platform/web/*"] }, failed)).toBeNull();
    // Regex characters in a name are literal.
    expect(matchJenkinsTrigger({ jobs: ["platform.api.main"] }, failed)).toBeNull();
  });

  it("filters on branches, and a branch filter misses a build with no branch", () => {
    expect(matchJenkinsTrigger({ branches: ["main"] }, failed)).toBe("failed");
    expect(matchJenkinsTrigger({ branches: ["release/*"] }, failed)).toBeNull();
    expect(matchJenkinsTrigger({ branches: ["main"] }, { ...failed, branch: null })).toBeNull();
  });

  it("never matches a phase no trigger fires on", () => {
    expect(matchJenkinsTrigger({ events: ["failed"] }, { ...failed, kind: null })).toBeNull();
  });
});

describe("Jenkins: params, delivery key and firing", () => {
  const failed = normalizeJenkinsEvent(PLUGIN_FAILED)!;

  it("hands the build's facts to the prompt as params", () => {
    const params = jenkinsEventParams(failed);
    expect(params).toMatchObject({
      source: "jenkins",
      event: "failed",
      job: "platform/api/main",
      jobName: "main",
      number: "42",
      status: "FAILURE",
      branch: "main",
      commit: "0123456789abcdef0123456789abcdef01234567",
      repoUrl: "https://gitlab.example.com/platform/api.git",
      durationMs: "61234",
    });
    expect(JSON.parse(params.parameters)).toEqual({ DEPLOY: "false" });
    expect(JSON.parse(params.payload).build.number).toBe(42);
  });

  it("keys a delivery by job, build and result, so COMPLETED and FINALIZED start one run", () => {
    const finalized = normalizeJenkinsEvent({
      ...PLUGIN_FAILED,
      build: { ...PLUGIN_FAILED.build, phase: "FINALIZED" },
    })!;
    expect(jenkinsDeliveryKey(failed)).toBe("jenkins:platform/api/main#42:failed");
    expect(jenkinsDeliveryKey(finalized)).toBe(jenkinsDeliveryKey(failed));
    expect(jenkinsDeliveryKey({ ...failed, number: null })).toBeNull();
  });

  it("builds the firing: title, message with the log's end, and the repo hint", () => {
    const firing = firingFor("jenkins", failed, { events: ["failed"] })!;
    expect(firing).toMatchObject({
      source: "jenkins",
      matched: "failed",
      title: "platform/api/main #42 failed",
      repoUrlHint: "https://gitlab.example.com/platform/api.git",
    });
    expect(firing.message).toContain("Jenkins build failed: platform/api/main #42");
    expect(firing.message).toContain("Branch: main · Commit: 0123456789ab");
    expect(firing.message).toContain("FAIL src/app.test.ts");
    expect(firingFor("jenkins", failed, { events: ["succeeded"] })).toBeNull();
  });
});
