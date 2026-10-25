import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// Only what a refused spawn / blueprint reaches: the host lookup, and the
// services a run that gets through would call.
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../services/session-sharing-service.js", () => ({ canJoinSession: vi.fn() }));
vi.mock("../services/local-limits-service.js", () => ({
  LimitsRefreshError: class extends Error {},
  refreshHostLimits: vi.fn(),
}));
const host = { id: "11111111-1111-4111-8111-111111111111", name: "laptop", userId: "u1" };
vi.mock("../services/local-host-service.js", () => ({
  getHost: vi.fn(async () => host),
  canAccessHost: () => true,
  findHostDirForRepo: () => null,
}));
vi.mock("../services/local-relay.js", () => ({}));
const mockCreateTerminal = vi.fn();
vi.mock("../services/local-terminal-service.js", () => ({
  createTerminal: (...args: unknown[]) => mockCreateTerminal(...args),
}));
const mockCheckBlueprint = vi.fn();
const mockCreateBlueprint = vi.fn();
vi.mock("../services/local-blueprint-service.js", () => ({
  checkBlueprint: (...args: unknown[]) => mockCheckBlueprint(...args),
  createBlueprint: (...args: unknown[]) => mockCreateBlueprint(...args),
}));
vi.mock("../services/local-dirs-service.js", () => ({
  HostDirError: class extends Error {},
  changeHostDir: vi.fn(),
}));
vi.mock("../services/trigger-service.js", () => ({}));
vi.mock("../services/git-token-service.js", () => ({ getGitPlatformForRepo: vi.fn() }));
vi.mock("../services/ticket-context.js", () => ({ buildTicketPrompt: vi.fn() }));

import { localRoutes } from "./local.js";

describe("Optio Local runtimes and OPTIO_RUNTIMES", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCheckBlueprint.mockResolvedValue("stop here");
    mockCreateTerminal.mockRejectedValue(new Error("stop here"));
    app = await buildRouteTestApp(localRoutes);
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  const spawn = (agent: string) =>
    app.inject({
      method: "POST",
      url: "/api/local/terminals",
      payload: { hostId: host.id, dir: "/src/app", spec: { kind: "agent", agent } },
    });
  const blueprint = (agent: string) =>
    app.inject({
      method: "POST",
      url: "/api/local/blueprints",
      payload: { name: "nightly", commandTemplate: "fix the build", agent },
    });

  it("refuses an agent spawn or automation with a runtime outside the list", async () => {
    vi.stubEnv("OPTIO_RUNTIMES", "claude-code,opencode");
    const res = await spawn("codex");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("codex isn't available in this deployment");
    expect(mockCreateTerminal).not.toHaveBeenCalled();

    const bp = await blueprint("gemini");
    expect(bp.statusCode).toBe(400);
    expect(bp.json().error).toBe("gemini isn't available in this deployment");
    expect(mockCheckBlueprint).not.toHaveBeenCalled();
  });

  it("lets the listed runtimes through", async () => {
    vi.stubEnv("OPTIO_RUNTIMES", "claude-code,opencode");
    expect((await spawn("claude-code")).json().error).toBe("stop here");
    expect(mockCreateTerminal).toHaveBeenCalled();
    expect((await blueprint("opencode")).json().error).toBe("stop here");
  });

  it("takes every runtime upstream offers by default", async () => {
    vi.stubEnv("OPTIO_RUNTIMES", "");
    expect((await spawn("codex")).json().error).toBe("stop here");
    expect((await blueprint("gemini")).json().error).toBe("stop here");
    expect(mockCheckBlueprint).toHaveBeenCalled();
  });
});
