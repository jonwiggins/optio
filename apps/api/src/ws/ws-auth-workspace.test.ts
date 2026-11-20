/**
 * Browsers open most sockets with the session cookie alone, so the workspace
 * a page uses rides on the `optio_workspace` cookie the web app keeps next to
 * its `x-workspace-id` header (the HTTP auth plugin reads the same two).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";

const mockValidateSession = vi.fn();
vi.mock("../services/session-service.js", () => ({
  validateSession: (...args: unknown[]) => mockValidateSession(...args),
  validateWsToken: vi.fn(),
}));
vi.mock("../services/oauth/index.js", () => ({ isAuthDisabled: () => false }));
const mockGetUserRole = vi.fn();
vi.mock("../services/workspace-service.js", () => ({
  getUserRole: (...args: unknown[]) => mockGetUserRole(...args),
}));
vi.mock("../services/api-key-service.js", () => ({ validateApiKey: vi.fn() }));

import { authenticateWs } from "./ws-auth.js";

const HOME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const socket = () => ({ close: vi.fn() });
const request = (headers: Record<string, string>) =>
  ({ headers, query: {} }) as unknown as FastifyRequest;

describe("authenticateWs workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateSession.mockImplementation(async () => ({ id: "user", workspaceId: HOME }));
    mockGetUserRole.mockImplementation(async (ws: string) =>
      ws === HOME ? "member" : ws === OTHER ? "admin" : null,
    );
  });

  it("uses the workspace in the optio_workspace cookie, with that workspace's role", async () => {
    const user = await authenticateWs(
      socket(),
      request({ cookie: `optio_session=valid; optio_workspace=${OTHER}` }),
    );
    expect(user).toMatchObject({ workspaceId: OTHER, workspaceRole: "admin" });
  });

  it("uses x-workspace-id over the cookie, as the HTTP plugin does", async () => {
    mockGetUserRole.mockImplementation(async () => "member");
    const user = await authenticateWs(
      socket(),
      request({ cookie: `optio_session=valid; optio_workspace=${OTHER}`, "x-workspace-id": HOME }),
    );
    expect(user?.workspaceId).toBe(HOME);
  });

  it("keeps the saved default when nothing names a workspace", async () => {
    const user = await authenticateWs(socket(), request({ cookie: "optio_session=valid" }));
    expect(user).toMatchObject({ workspaceId: HOME, workspaceRole: "member" });
  });

  it("refuses a named workspace the user is not in, without falling back to the default", async () => {
    const s = socket();
    const user = await authenticateWs(
      s,
      request({
        cookie: "optio_session=valid; optio_workspace=33333333-3333-4333-8333-333333333333",
      }),
    );
    expect(user).toBeNull();
    expect(s.close).toHaveBeenCalledWith(4403, "Workspace membership required");
  });

  it("refuses a malformed workspace id", async () => {
    const s = socket();
    expect(
      await authenticateWs(s, request({ cookie: "optio_session=valid; optio_workspace=x" })),
    ).toBeNull();
    expect(s.close).toHaveBeenCalledWith(4403, "Invalid workspace");
    expect(mockGetUserRole).not.toHaveBeenCalled();
  });
});
