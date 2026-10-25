import { afterEach, describe, expect, it, vi } from "vitest";
import { changesAccessGroups, isGlobalSecretScope } from "./deployment-admin-gates.js";
import { envWorkspaceCreation, isWorkspaceCreation } from "./deployment-settings.js";

describe("isGlobalSecretScope", () => {
  it("is the deployment-wide scope, and what an omitted one means", () => {
    expect(isGlobalSecretScope(undefined)).toBe(true);
    expect(isGlobalSecretScope("")).toBe(true);
    expect(isGlobalSecretScope("global")).toBe(true);
  });

  it("leaves a person's, a team's and a repo's secrets to their own rules", () => {
    expect(isGlobalSecretScope("user")).toBe(false);
    expect(isGlobalSecretScope("team")).toBe(false);
    expect(isGlobalSecretScope("https://gitlab.example.com/platform/my.service")).toBe(false);
  });
});

describe("changesAccessGroups", () => {
  it("on a new workspace: any group, or the viewer role", () => {
    expect(changesAccessGroups({})).toBe(false);
    expect(changesAccessGroups({ accessGroups: [] })).toBe(false);
    expect(changesAccessGroups({ accessGroups: ["  "] })).toBe(false);
    expect(changesAccessGroups({ accessGroups: ["Platform-Devs"] })).toBe(true);
    expect(changesAccessGroups({ accessGroupsRole: "member" })).toBe(false);
    expect(changesAccessGroups({ accessGroupsRole: "viewer" })).toBe(true);
  });

  it("on an existing one: only a change counts (a client may resend its whole form)", () => {
    const current = { accessGroups: ["devs", "ops"], accessGroupsRole: "member" };
    expect(changesAccessGroups({ accessGroups: ["OPS", "devs "] }, current)).toBe(false);
    expect(changesAccessGroups({ accessGroupsRole: "member" }, current)).toBe(false);
    expect(changesAccessGroups({ accessGroups: ["devs"] }, current)).toBe(true);
    expect(changesAccessGroups({ accessGroups: ["devs", "ops", "qa"] }, current)).toBe(true);
    expect(changesAccessGroups({ accessGroupsRole: "viewer" }, current)).toBe(true);
    expect(changesAccessGroups({ accessGroups: [] }, { accessGroups: null })).toBe(false);
  });
});

describe("workspaces.creation from the environment", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is everyone unless it says admins", () => {
    vi.stubEnv("OPTIO_WORKSPACE_CREATION", "");
    expect(envWorkspaceCreation()).toBe("everyone");
    vi.stubEnv("OPTIO_WORKSPACE_CREATION", "Admins");
    expect(envWorkspaceCreation()).toBe("admins");
    vi.stubEnv("OPTIO_WORKSPACE_CREATION", "anyone");
    expect(envWorkspaceCreation()).toBe("everyone");
  });

  it("knows its two values", () => {
    expect(isWorkspaceCreation("admins")).toBe(true);
    expect(isWorkspaceCreation("everyone")).toBe(true);
    expect(isWorkspaceCreation("members")).toBe(false);
  });
});
