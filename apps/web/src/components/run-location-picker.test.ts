import { describe, it, expect } from "vitest";
import {
  CLUSTER_RUN_LOCATION,
  agentRunsLocally,
  runLocationFromRow,
  runLocationPayload,
  defaultDir,
  joinSubpath,
  repoUrlFromRemote,
  rootDirFor,
  subpathError,
  subpathOf,
  shortRepo,
  usableDir,
} from "./run-location-picker";

describe("runLocationFromRow", () => {
  it("defaults to the cluster for missing rows and cluster rows", () => {
    expect(runLocationFromRow(null)).toEqual(CLUSTER_RUN_LOCATION);
    expect(runLocationFromRow({ runTarget: "cluster", localHostId: "h", localDir: "/x" })).toEqual(
      CLUSTER_RUN_LOCATION,
    );
  });

  it("reads a local row back, defaulting the session mode to headless", () => {
    expect(
      runLocationFromRow({ runTarget: "local", localHostId: "h1", localDir: "/home/dev/app" }),
    ).toEqual({
      runTarget: "local",
      localHostId: "h1",
      localDir: "/home/dev/app",
      localSessionMode: "headless",
    });
    expect(
      runLocationFromRow({
        runTarget: "local",
        localHostId: "h1",
        localDir: "/home/dev/app",
        localSessionMode: "interactive",
      }).localSessionMode,
    ).toBe("interactive");
  });
});

describe("runLocationPayload", () => {
  it("clears the local fields when the target is the cluster", () => {
    expect(
      runLocationPayload({
        runTarget: "cluster",
        localHostId: "stale",
        localDir: "/stale",
        localSessionMode: "interactive",
      }),
    ).toEqual({ runTarget: "cluster", localHostId: null, localDir: null, localSessionMode: null });
  });

  it("passes a local location through", () => {
    expect(
      runLocationPayload({
        runTarget: "local",
        localHostId: "h1",
        localDir: "/home/dev/app",
        localSessionMode: "headless",
      }),
    ).toEqual({
      runTarget: "local",
      localHostId: "h1",
      localDir: "/home/dev/app",
      localSessionMode: "headless",
    });
  });
});

describe("agentRunsLocally", () => {
  it("knows which agent runtimes the local daemon can launch", () => {
    for (const a of ["claude-code", "codex", "cursor", "gemini", "opencode"]) {
      expect(agentRunsLocally(a)).toBe(true);
    }
    expect(agentRunsLocally("copilot")).toBe(false);
    expect(agentRunsLocally("openclaw")).toBe(false);
    expect(agentRunsLocally(undefined)).toBe(false);
  });
});

describe("local directories", () => {
  const dirs = [
    { path: "/home/dev/notes" },
    { path: "/home/dev/app", repoUrl: "https://github.com/acme/app" },
  ];

  it("lets a Job use any directory but a Task only a git checkout", () => {
    expect(usableDir("job", dirs[0])).toBe(true);
    expect(usableDir("task", dirs[0])).toBe(false);
    expect(usableDir("task", dirs[1])).toBe(true);
  });

  it("defaults to the first usable directory, keeping a still-valid choice", () => {
    expect(defaultDir("job", dirs, "")).toBe("/home/dev/notes");
    expect(defaultDir("task", dirs, "")).toBe("/home/dev/app");
    expect(defaultDir("task", dirs, "/home/dev/notes")).toBe("/home/dev/app");
    expect(defaultDir("job", dirs, "/home/dev/app")).toBe("/home/dev/app");
    expect(defaultDir("task", [dirs[0]], "")).toBe("");
  });

  it("turns the daemon's remote into the https repo URL the API accepts", () => {
    expect(repoUrlFromRemote("git@github.com:acme/app.git")).toBe("https://github.com/acme/app");
    expect(repoUrlFromRemote("https://github.com/acme/app.git")).toBe(
      "https://github.com/acme/app",
    );
    expect(repoUrlFromRemote(undefined)).toBeNull();
  });

  it("shortens a remote for display", () => {
    expect(shortRepo("https://github.com/acme/app.git")).toBe("github.com/acme/app");
    expect(shortRepo("git@gitlab.com:acme/app.git")).toBe("gitlab.com/acme/app");
  });
});

describe("subdirectories of an allowlisted directory (#622)", () => {
  const dirs = [
    { path: "/home/dev/notes" },
    { path: "/home/dev/app", repoUrl: "git@github.com:acme/app.git" },
    { path: "/home/dev/app/vendor/lib" },
  ];

  it("finds the longest allowlisted root a directory sits under", () => {
    expect(rootDirFor(dirs, "/home/dev/app")?.path).toBe("/home/dev/app");
    expect(rootDirFor(dirs, "/home/dev/app/packages/api")?.path).toBe("/home/dev/app");
    expect(rootDirFor(dirs, "/home/dev/app/vendor/lib/src")?.path).toBe("/home/dev/app/vendor/lib");
    expect(rootDirFor(dirs, "/home/dev/application")).toBeUndefined();
    expect(rootDirFor(dirs, "")).toBeUndefined();
    expect(rootDirFor([{ path: "/" }], "/srv")?.path).toBe("/");
  });

  it("splits and joins the subpath", () => {
    expect(subpathOf("/home/dev/app", "/home/dev/app")).toBe("");
    expect(subpathOf("/home/dev/app", "/home/dev/app/packages/api")).toBe("packages/api");
    expect(joinSubpath("/home/dev/app", "")).toBe("/home/dev/app");
    expect(joinSubpath("/home/dev/app", " packages//api/ ")).toBe("/home/dev/app/packages/api");
    expect(joinSubpath("/home/dev/app/", "./src")).toBe("/home/dev/app/src");
    expect(joinSubpath("/", "srv")).toBe("/srv");
  });

  it("only accepts relative paths that stay inside the directory", () => {
    expect(subpathError("")).toBeNull();
    expect(subpathError("packages/api")).toBeNull();
    expect(subpathError("/etc")).toMatch(/relative/);
    expect(subpathError("~/x")).toMatch(/relative/);
    expect(subpathError("../other")).toMatch(/\.\./);
    expect(subpathError("a/../../b")).toMatch(/\.\./);
  });

  it("keeps a subdirectory selection when re-adopting a host's directory", () => {
    expect(defaultDir("task", dirs, "/home/dev/app/packages/api")).toBe(
      "/home/dev/app/packages/api",
    );
    // Under a non-checkout root a Task still moves to a checkout.
    expect(defaultDir("task", dirs, "/home/dev/notes/sub")).toBe("/home/dev/app");
    expect(defaultDir("job", dirs, "/home/dev/notes/sub")).toBe("/home/dev/notes/sub");
  });
});
