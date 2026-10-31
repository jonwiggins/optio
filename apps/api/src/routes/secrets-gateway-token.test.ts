import { describe, it, expect, vi } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// A gateway token (`gateway:<providerId>`) is written only by the gateway's
// own routes, with its consent (routes/model-gateway.ts): never through
// POST /api/secrets, at any scope.

vi.mock("../services/sign-in-config-service.js", () => ({
  isDeploymentAdmin: vi.fn().mockResolvedValue(true),
  hasDeploymentAdmin: vi.fn().mockResolvedValue(true),
  isFoundingWorkspaceAdmin: vi.fn().mockResolvedValue(false),
}));
vi.mock("../services/workspace-service.js", () => ({ getUserRole: vi.fn() }));
const mockStoreSecret = vi.fn();
vi.mock("../services/secret-service.js", () => ({
  listVisibleSecrets: vi.fn(),
  storeSecret: (...args: unknown[]) => mockStoreSecret(...args),
  deleteSecret: vi.fn(),
}));
vi.mock("../services/event-bus.js", () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../workers/token-validation-worker.js", () => ({
  validateClaudeToken: vi.fn(),
  recordTokenValidation: vi.fn(),
}));

import { secretRoutes } from "./secrets.js";

describe("POST /api/secrets and gateway tokens", () => {
  it("refuses a gateway token's name at every scope", async () => {
    const app = await buildRouteTestApp(secretRoutes);
    for (const scope of [undefined, "user", "gateway"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/secrets",
        payload: {
          name: "gateway:11111111-1111-4111-8111-111111111111",
          value: "planted",
          ...(scope ? { scope } : {}),
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/Settings → My tokens/);
    }
    expect(mockStoreSecret).not.toHaveBeenCalled();
  });
});
