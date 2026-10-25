import { describe, expect, it } from "vitest";
import { isRefusal, mayManageWebhook, type WebhookViewer } from "./webhook-access";

const viewer = (over: Partial<WebhookViewer> = {}): WebhookViewer => ({
  authDisabled: false,
  userId: "u-member",
  isAdmin: false,
  isDeploymentAdmin: false,
  ...over,
});

describe("mayManageWebhook (the server's webhookRefusal)", () => {
  const hook = { workspaceId: "ws-1", createdBy: "u-creator" };

  it("lets the creator and a workspace admin, not another member", () => {
    expect(mayManageWebhook(hook, viewer({ userId: "u-creator" }))).toBe(true);
    expect(mayManageWebhook(hook, viewer({ isAdmin: true }))).toBe(true);
    expect(mayManageWebhook(hook, viewer())).toBe(false);
    expect(mayManageWebhook(hook, viewer({ userId: null }))).toBe(false);
  });

  it("keeps a hook with no workspace to deployment admins, its creator included", () => {
    const old = { workspaceId: null, createdBy: "u-creator" };
    expect(mayManageWebhook(old, viewer({ userId: "u-creator" }))).toBe(false);
    expect(mayManageWebhook(old, viewer({ isAdmin: true }))).toBe(false);
    expect(mayManageWebhook(old, viewer({ isDeploymentAdmin: true }))).toBe(true);
  });

  it("lets everyone with auth disabled", () => {
    expect(mayManageWebhook({ workspaceId: null }, viewer({ authDisabled: true }))).toBe(true);
  });
});

describe("isRefusal", () => {
  it("is a 403 from the API client, nothing else", () => {
    expect(isRefusal(Object.assign(new Error("no"), { status: 403 }))).toBe(true);
    expect(isRefusal(Object.assign(new Error("gone"), { status: 404 }))).toBe(false);
    expect(isRefusal(new Error("network"))).toBe(false);
    expect(isRefusal(null)).toBe(false);
  });
});
