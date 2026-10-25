import { describe, expect, it } from "vitest";
import { canSeeCheck, type HealthViewer, workspaceManaged } from "./store.js";

const WS = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const org = (
  kind: "gitlab" | "gateway" | "jira" | "remote_workspace",
  key: string,
  workspaceId: string | null,
) => ({
  credentialKey: key,
  kind,
  scope: "organization" as const,
  workspaceId,
  userId: null,
  teamId: null,
});
const wsAdmin: HealthViewer = {
  userId: "u-admin",
  workspaceId: WS,
  isWorkspaceAdmin: true,
  adminTeamIds: [],
  deploymentAdmin: false,
};

describe("what a workspace's admins manage", () => {
  it("its Jira and Coder connections and its gateways' shared tokens", () => {
    expect(workspaceManaged(org("jira", "jira:1", WS))).toBe(true);
    expect(workspaceManaged(org("remote_workspace", "remote_workspace:1", WS))).toBe(true);
    expect(workspaceManaged(org("gateway", "gateway:p1:stored", WS))).toBe(true);
    // A gateway's organization token is a deployment secret; the GitLab token is the deployment's.
    expect(workspaceManaged(org("gateway", "gateway:p1:org", WS))).toBe(false);
    expect(workspaceManaged(org("gitlab", "gitlab:org", null))).toBe(false);
    // Not recorded yet: the credential's own key.
    const { kind, scope, workspaceId, userId, teamId } = org("gateway", "", WS);
    expect(
      workspaceManaged({ kind, scope, workspaceId, userId, teamId, key: "gateway:p1:stored" }),
    ).toBe(true);
  });

  it("a workspace admin sees its own workspace's, never another's", () => {
    expect(canSeeCheck(org("gateway", "gateway:p1:stored", WS), wsAdmin)).toBe(true);
    expect(canSeeCheck(org("gateway", "gateway:p2:stored", OTHER), wsAdmin)).toBe(false);
    expect(canSeeCheck(org("gateway", "gateway:p1:org", WS), wsAdmin)).toBe(false);
    expect(
      canSeeCheck(org("gateway", "gateway:p1:stored", WS), { ...wsAdmin, isWorkspaceAdmin: false }),
    ).toBe(false);
  });
});
