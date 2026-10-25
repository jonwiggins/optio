import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect } from "vitest";
import { localAgentChoices, runLocationFromRow, runLocationPayload } from "./run-location-picker";

describe("runLocationFromRow in a remote workspace", () => {
  it("reads saved remote-workspace work back so saving an edit keeps its workspace", () => {
    const fresh = {
      connectionId: "c1",
      templateId: "t1",
      templateVersionId: "v7",
      parameters: { repo_url: "https://git.example.com/app.git", cpu: "4" },
      name: "nightly",
      checkoutDir: "/work/app",
    };
    const loaded = runLocationFromRow({
      runTarget: "local",
      localHostId: "pinned-host",
      localDir: "/work/app",
      remoteWorkspaceLaunch: fresh,
    });
    expect(loaded.localHostId).toBe("");
    expect(loaded.remoteWorkspace?.source).toBe("new");
    expect(runLocationPayload(loaded)).toMatchObject({
      runTarget: "local",
      localHostId: null,
      remoteWorkspace: { ...fresh, workspaceId: null },
    });
    const existing = runLocationFromRow({
      runTarget: "local",
      remoteWorkspaceLaunch: { connectionId: null, workspaceId: "ws-1", checkoutDir: null },
    });
    expect(existing.remoteWorkspace).toMatchObject({ source: "existing", workspaceId: "ws-1" });
    expect(runLocationPayload(existing)).toMatchObject({
      remoteWorkspace: {
        connectionId: null,
        workspaceId: "ws-1",
        templateId: null,
        parameters: null,
      },
    });
  });
});

describe("runLocationPayload in a remote workspace", () => {
  const remote = {
    connectionId: "c1",
    source: "new" as const,
    workspaceId: "stale",
    templateId: "t2",
    parameters: { region: "us" },
    name: " my-ws ",
    checkoutDir: "",
    repoUrl: "https://gitlab.example.com/team/app",
  };

  it("stays a local run and carries where.remoteWorkspace, the machine left to the API", () => {
    expect(
      runLocationPayload({
        runTarget: "local",
        localHostId: "stale",
        localDir: "/stale",
        localSessionMode: "headless",
        remoteWorkspace: remote,
      }),
    ).toEqual({
      runTarget: "local",
      localHostId: null,
      localDir: null,
      localSessionMode: "headless",
      remoteWorkspace: {
        connectionId: "c1",
        workspaceId: null,
        templateId: "t2",
        parameters: { region: "us", repo_url: "https://gitlab.example.com/team/app" },
        name: "my-ws",
        checkoutDir: null,
      },
    });
  });

  it("starts an existing workspace with only the repo parameter", () => {
    const payload = runLocationPayload({
      runTarget: "local",
      localHostId: "",
      localDir: "",
      localSessionMode: "headless",
      remoteWorkspace: {
        ...remote,
        source: "existing",
        workspaceId: "w1",
        checkoutDir: "/src/app",
      },
    });
    expect(payload).toMatchObject({
      remoteWorkspace: {
        workspaceId: "w1",
        templateId: null,
        name: null,
        parameters: { repo_url: "https://gitlab.example.com/team/app" },
        checkoutDir: "/src/app",
      },
    });
  });
});

describe("localAgentChoices (the deployment features)", () => {
  it("names every local agent CLI under the default deployment", () => {
    expect(localAgentChoices(featuresFromEnv({}))).toBe(
      "Claude Code, Codex, Cursor, Gemini, or OpenCode",
    );
  });

  it("names the restricted deployment's two", () => {
    expect(
      localAgentChoices(
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toBe("Claude Code or OpenCode");
  });
});
