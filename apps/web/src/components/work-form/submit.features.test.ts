import { beforeEach, describe, expect, it, vi } from "vitest";
import { kindOfSpec, type WorkCreated, type WorkSpec } from "@optio/shared";

const api = vi.hoisted(() => ({
  createWork: vi.fn(),
  updateWork: vi.fn(),
  putWorkDefaults: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("@/lib/persistent-agent-defaults", () => ({ defaultAgentsMd: () => "DEFAULT AGENTS.MD" }));

import { createWork, specFor } from "./submit";
import { EMPTY_DRAFT, normalize, type WorkDraft, type WorkKind } from "./model";

const REPO = "https://github.com/acme/app";

const draft = (patch: Partial<WorkDraft>): WorkDraft => normalize({ ...EMPTY_DRAFT, ...patch });
const sent = (): WorkSpec => api.createWork.mock.calls.at(-1)![0];

/** What the server answers a create with. */
const made = (kind: WorkKind, id: string, href: string, run?: WorkCreated["run"]): WorkCreated => ({
  kind,
  id,
  href,
  ...(run ? { run } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  api.createWork.mockResolvedValue(made("standalone", "w-1", "/jobs/w-1"));
  api.updateWork.mockResolvedValue(made("standalone", "w-1", "/jobs/w-1"));
});

describe("a team's work on the wire", () => {
  it("a team's pod Job sends the team as its owner", async () => {
    const TEAM = "team:11111111-2222-4333-8444-555555555555" as const;
    await createWork(draft({ withRepo: false, prompt: "hi", owner: TEAM, podSecrets: ["A"] }), {
      repoUrl: "",
      autoName: "Job 3",
    });
    expect(sent()).toMatchObject({ owner: TEAM, podSecrets: ["A"] });
  });
});

describe("Work until merged with the automatic-merge confirmation", () => {
  const untilMerged = draft({ prompt: "fix it", repoUrl: REPO, then: "until-merged" });

  beforeEach(() => api.createWork.mockResolvedValue(made("repo-task", "t-1", "/tasks/t-1")));

  it("sends the confirmation only when the dialog was accepted", async () => {
    const created = await createWork(
      { ...untilMerged, mergeWhenReady: true, autoMergeConfirmed: true },
      { repoUrl: REPO, autoName: "Task 1" },
    );
    expect(sent()).toMatchObject({
      then: "until-merged",
      mergeWhenReady: true,
      autoMergeConfirmed: true,
    });
    expect(kindOfSpec(sent())).toBe("repo-task");
    expect(created.toast).toBe("Task 1 started — it will work the PR until it merges");
  });

  it("never claims a confirmation it didn't get", async () => {
    await createWork(untilMerged, { repoUrl: REPO, autoName: "Task 1" });
    expect(sent()).toMatchObject({ then: "until-merged", mergeWhenReady: true });
    expect(sent()).not.toHaveProperty("autoMergeConfirmed");

    api.createWork.mockClear();
    await createWork(
      { ...untilMerged, mergeWhenReady: false, autoMergeConfirmed: true },
      { repoUrl: REPO, autoName: "T" },
    );
    expect(sent()).toMatchObject({ mergeWhenReady: false });
    expect(sent()).not.toHaveProperty("autoMergeConfirmed");
  });
});

describe("specFor — in a remote workspace", () => {
  const remote = {
    connectionId: "c1",
    source: "new" as const,
    workspaceId: "",
    templateId: "",
    parameters: {},
    name: "",
    checkoutDir: "",
    repoUrl: "https://gitlab.example.com/team/app",
  };

  it("is a local Task with where.remoteWorkspace; the API fills in the machine and checkout", () => {
    const d = draft({
      runtime: "claude-code",
      prompt: "Fix it",
      withRepo: true,
      // A machine picked before stays in the draft; it doesn't travel.
      location: {
        runTarget: "local",
        localHostId: "h-old",
        localDir: "/old/dir",
        localSessionMode: "headless",
        remoteWorkspace: remote,
      },
    });
    const spec = specFor(d, { repoUrl: remote.repoUrl, name: "Fix" });
    expect(kindOfSpec(spec)).toBe("repo-task");
    expect(spec.where).toEqual({
      runTarget: "local",
      repoUrl: remote.repoUrl,
      repoBranch: "main",
      localHostId: null,
      localDir: null,
      remoteWorkspace: {
        connectionId: "c1",
        workspaceId: null,
        templateId: null,
        parameters: { repo_url: remote.repoUrl },
        name: null,
        checkoutDir: null,
      },
    });
  });
});
