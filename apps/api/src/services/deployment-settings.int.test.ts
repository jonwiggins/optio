import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { users, workspaceMembers } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { deploymentSettingsRoutes } from "../routes/deployment-settings.js";
import { workspaceRoutes } from "../routes/workspaces.js";
import {
  WORKSPACE_CREATION_KEY,
  getDeploymentSetting,
  setDeploymentSetting,
} from "./deployment-settings.js";

beforeEach(async () => {
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", "");
  vi.stubEnv("OPTIO_WORKSPACE_CREATION", "");
  await setDeploymentSetting(WORKSPACE_CREATION_KEY, null, null);
});
afterEach(() => vi.unstubAllEnvs());

async function appAs(deploymentAdmin = false) {
  const ws = await insertWorkspace();
  const [user] = await db
    .insert(users)
    .values({
      email: randomUUID() + "@settings.example.test",
      provider: "github",
      externalId: randomUUID(),
      displayName: "Settings test",
      deploymentAdmin,
    })
    .returning();
  await db.insert(workspaceMembers).values({ userId: user.id, workspaceId: ws.id, role: "admin" });
  return buildRouteTestApp(
    async (app) => {
      await deploymentSettingsRoutes(app);
      await workspaceRoutes(app);
    },
    { user: { id: user.id, workspaceId: ws.id, workspaceRole: "admin" } },
  );
}

describe("deployment workspace-creation policy", () => {
  it("retains everyone by default, while separating workspace and deployment admins", async () => {
    const app = await appAs();
    try {
      const response = await app.inject({ method: "GET", url: "/api/deployment-settings" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        workspaceCreation: { value: "everyone", environment: "everyone", source: "environment" },
        canEdit: false,
        mayCreateWorkspace: true,
      });
    } finally {
      await app.close();
    }
  });

  it("refuses a workspace admin changing deployment policy without writing it", async () => {
    const app = await appAs();
    try {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/deployment-settings",
            payload: { workspaceCreation: "admins" },
          })
        ).statusCode,
      ).toBe(403);
      expect(await getDeploymentSetting(WORKSPACE_CREATION_KEY)).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("applies an admin override to other callers immediately and enforces it on creation", async () => {
    const admin = await appAs(true);
    const member = await appAs();
    try {
      const changed = await admin.inject({
        method: "PUT",
        url: "/api/deployment-settings",
        payload: { workspaceCreation: "admins" },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({
        canEdit: true,
        mayCreateWorkspace: true,
        workspaceCreation: { value: "admins", source: "app" },
      });
      expect(
        (await member.inject({ method: "GET", url: "/api/deployment-settings" })).json(),
      ).toMatchObject({ mayCreateWorkspace: false });
      const name = "settings-" + randomUUID();
      expect(
        (
          await member.inject({
            method: "POST",
            url: "/api/workspaces",
            payload: { name, slug: name },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await admin.inject({
            method: "POST",
            url: "/api/workspaces",
            payload: { name, slug: name },
          })
        ).statusCode,
      ).toBe(201);
    } finally {
      await admin.close();
      await member.close();
    }
  });

  it("removes an override when following the environment again", async () => {
    vi.stubEnv("OPTIO_WORKSPACE_CREATION", "admins");
    const admin = await appAs(true);
    try {
      await admin.inject({
        method: "PUT",
        url: "/api/deployment-settings",
        payload: { workspaceCreation: "everyone" },
      });
      const response = await admin.inject({
        method: "PUT",
        url: "/api/deployment-settings",
        payload: { workspaceCreation: null },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().workspaceCreation).toEqual({
        value: "admins",
        environment: "admins",
        source: "environment",
      });
      expect(await getDeploymentSetting(WORKSPACE_CREATION_KEY)).toBeUndefined();
    } finally {
      await admin.close();
    }
  });
});
