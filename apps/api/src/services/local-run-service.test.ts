import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────
// The pure helpers under test don't touch the DB; the module's imports do.

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../logger.js", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock("./local-terminal-service.js", () => ({
  createTerminal: vi.fn(),
  getTerminal: vi.fn(),
  killTerminal: vi.fn(),
}));
vi.mock("./task-service.js", () => ({
  getTask: vi.fn(),
  tryTransitionTask: vi.fn(),
  updateTaskPr: vi.fn(),
  updateTaskResult: vi.fn(),
  updateTaskSession: vi.fn(),
}));
vi.mock("./workflow-service.js", () => ({ transitionWorkflowRunCas: vi.fn() }));

const mockGetHost = vi.fn();
const mockCanAccessHost = vi.fn();
vi.mock("./local-host-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./local-host-service.js")>();
  return {
    ...actual,
    getHost: (...args: unknown[]) => mockGetHost(...args),
    canAccessHost: (...args: unknown[]) => mockCanAccessHost(...args),
  };
});

import {
  allowlistEntryFor,
  buildLocalTaskPrompt,
  prLinkForTask,
  validateRunLocation,
  CLUSTER_LOCATION,
} from "./local-run-service.js";

const host = {
  id: "host-1",
  userId: "user-1",
  name: "laptop",
  dirs: [
    { path: "/home/dev/optio", repoUrl: "https://github.com/acme/optio" },
    { path: "/home/dev/optio/apps", repoUrl: "https://github.com/acme/optio-apps" },
    { path: "/home/dev/scratch" },
  ],
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetHost.mockResolvedValue(host);
  mockCanAccessHost.mockReturnValue(true);
});

// ── allowlistEntryFor ────────────────────────────────────────────────────────

describe("allowlistEntryFor", () => {
  it("returns the exact or longest-prefix allowlist entry", () => {
    expect(allowlistEntryFor(host, "/home/dev/optio")?.path).toBe("/home/dev/optio");
    expect(allowlistEntryFor(host, "/home/dev/optio/packages")?.path).toBe("/home/dev/optio");
    // Nested entry wins over its parent.
    expect(allowlistEntryFor(host, "/home/dev/optio/apps/web")?.path).toBe("/home/dev/optio/apps");
    expect(allowlistEntryFor(host, "/home/dev/scratch/")?.path).toBe("/home/dev/scratch");
  });

  it("does not match a sibling that merely shares a prefix", () => {
    expect(allowlistEntryFor(host, "/home/dev/optio-other")).toBeNull();
    expect(allowlistEntryFor(host, "/tmp")).toBeNull();
  });
});

// ── validateRunLocation ──────────────────────────────────────────────────────

describe("validateRunLocation", () => {
  it("accepts cluster with no other fields and normalizes local fields away", async () => {
    const res = await validateRunLocation(
      { runTarget: "cluster", localHostId: "host-1", localDir: "/home/dev/optio" },
      "user-1",
    );
    expect(res).toEqual({ ok: true, location: CLUSTER_LOCATION });
    expect(mockGetHost).not.toHaveBeenCalled();
  });

  it("treats a missing runTarget as cluster", async () => {
    expect(await validateRunLocation({}, "user-1")).toEqual({
      ok: true,
      location: CLUSTER_LOCATION,
    });
  });

  it("requires a host and a directory for local", async () => {
    expect(await validateRunLocation({ runTarget: "local" }, "user-1")).toMatchObject({
      ok: false,
      error: expect.stringContaining("machine"),
    });
    expect(
      await validateRunLocation(
        { runTarget: "local", localHostId: "host-1", localDir: "  " },
        "user-1",
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("directory") });
  });

  it("rejects agents the daemon cannot launch before touching the host", async () => {
    const res = await validateRunLocation(
      {
        runTarget: "local",
        localHostId: "host-1",
        localDir: "/home/dev/optio",
        agentType: "copilot",
      },
      "user-1",
    );
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("copilot") });
    expect(mockGetHost).not.toHaveBeenCalled();
  });

  it("hides hosts the caller does not own", async () => {
    mockCanAccessHost.mockReturnValue(false);
    const res = await validateRunLocation(
      { runTarget: "local", localHostId: "host-1", localDir: "/home/dev/optio" },
      "someone-else",
    );
    expect(res).toEqual({ ok: false, error: "Host not found" });
  });

  it("rejects directories outside the host allowlist", async () => {
    const res = await validateRunLocation(
      { runTarget: "local", localHostId: "host-1", localDir: "/etc" },
      "user-1",
    );
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("optio local add") });
  });

  it("rejects a checkout of a different repo for Repo Tasks", async () => {
    const res = await validateRunLocation(
      {
        runTarget: "local",
        localHostId: "host-1",
        localDir: "/home/dev/optio",
        repoUrl: "https://github.com/acme/other",
      },
      "user-1",
    );
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("checkout of") });
  });

  it("accepts a matching checkout (normalized) and a dir with no detected remote", async () => {
    const ok = await validateRunLocation(
      {
        runTarget: "local",
        localHostId: "host-1",
        localDir: "/home/dev/optio",
        repoUrl: "https://github.com/acme/optio.git",
        agentType: "claude-code",
      },
      "user-1",
    );
    expect(ok).toEqual({
      ok: true,
      location: {
        runTarget: "local",
        localHostId: "host-1",
        localDir: "/home/dev/optio",
        localSessionMode: "headless",
      },
    });
    const scratch = await validateRunLocation(
      {
        runTarget: "local",
        localHostId: "host-1",
        localDir: "/home/dev/scratch",
        repoUrl: "https://github.com/acme/other",
        localSessionMode: "interactive",
      },
      "user-1",
    );
    expect(scratch).toMatchObject({ ok: true, location: { localSessionMode: "interactive" } });
  });
});

// ── buildLocalTaskPrompt ─────────────────────────────────────────────────────

describe("buildLocalTaskPrompt", () => {
  const task = {
    id: "11111111-2222-3333-4444-555555555555",
    title: "Fix flaky tests",
    prompt: "Make the suite deterministic.",
    repoUrl: "https://github.com/acme/optio",
    repoBranch: "develop",
  };

  it("keeps the task prompt first and adds branch + PR instructions", () => {
    const p = buildLocalTaskPrompt(task);
    expect(p.startsWith("Make the suite deterministic.")).toBe(true);
    expect(p).toContain("acme/optio");
    expect(p).toContain("optio/task-11111111-2222-3333-4444-555555555555");
    expect(p).toContain("`develop`");
    expect(p).toContain("gh pr create");
    expect(p).toContain("pull request URL");
  });

  it("speaks GitLab for GitLab repos", () => {
    const p = buildLocalTaskPrompt({ ...task, repoUrl: "https://gitlab.com/acme/optio" });
    expect(p).toContain("glab mr create");
    expect(p).toContain("merge request");
    expect(p).not.toContain("gh pr create");
  });

  it("uses the resume prompt with the original for context when resuming", () => {
    const p = buildLocalTaskPrompt(task, "CI is failing, fix it.");
    expect(p.startsWith("CI is failing, fix it.")).toBe(true);
    expect(p).toContain("Original task prompt for context:\nMake the suite deterministic.");
    expect(p).not.toContain("gh pr create");
  });
});

// ── prLinkForTask ────────────────────────────────────────────────────────────

describe("prLinkForTask", () => {
  const task = { repoUrl: "https://github.com/acme/optio" };
  const pr = (url: string) => ({
    url,
    kind: "pr" as const,
    provider: "github" as const,
    label: "pr",
  });

  it("returns the first PR link that belongs to the task's repo", () => {
    const links = [
      {
        url: "https://github.com/acme/optio/issues/3",
        kind: "issue" as const,
        provider: "github" as const,
        label: "#3",
      },
      pr("https://github.com/other/repo/pull/9"),
      pr("https://github.com/Acme/Optio/pull/12"),
      pr("https://github.com/acme/optio/pull/13"),
    ];
    expect(prLinkForTask(task, links)?.url).toBe("https://github.com/Acme/Optio/pull/12");
  });

  it("ignores PRs of other repos and non-PR links", () => {
    expect(prLinkForTask(task, [pr("https://github.com/other/repo/pull/9")])).toBeNull();
    expect(prLinkForTask(task, [])).toBeNull();
    expect(prLinkForTask(task, null)).toBeNull();
  });
});
