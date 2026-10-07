import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

const mockList = vi.fn();
const mockCreate = vi.fn();
const mockVerify = vi.fn();
vi.mock("../services/agent-credential-service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/agent-credential-service.js")>(
    "../services/agent-credential-service.js",
  );
  return {
    ...actual,
    listAgentCredentials: (...args: unknown[]) => mockList(...args),
    createAgentCredential: (...args: unknown[]) => mockCreate(...args),
    verifyAgentCredential: (...args: unknown[]) => mockVerify(...args),
  };
});
const mockLogAction = vi.fn();
vi.mock("../services/optio-action-service.js", () => ({
  logAction: (...args: unknown[]) => mockLogAction(...args),
}));

import { agentCredentialRoutes } from "./agent-credentials.js";
import { AgentCredentialError } from "../services/agent-credential-service.js";

const CREDENTIAL = {
  id: "secret:11111111-1111-4111-8111-111111111111",
  kind: "secret",
  method: "api-key",
  label: "Anthropic API key",
  secretName: "ANTHROPIC_API_KEY",
  providerId: null,
  owner: "me",
  ownerUserId: "user-1",
  ownerName: null,
  default: false,
  updatedAt: null,
};

describe("agent credential routes", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildRouteTestApp(agentCredentialRoutes);
  });

  it("lists the agent's credentials for the caller and the owner the form shows", async () => {
    mockList.mockResolvedValue({ credentials: [CREDENTIAL], addable: [] });
    const res = await app.inject({
      method: "GET",
      url: "/api/agents/credentials?agentType=claude-code&owner=me",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().credentials).toHaveLength(1);
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", isAdmin: true }),
      "claude-code",
      "me",
    );
  });

  it("needs an agent type", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents/credentials" });
    expect(res.statusCode).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("stores a credential, logs the action without the value, and answers 201", async () => {
    mockCreate.mockResolvedValue(CREDENTIAL);
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/credentials",
      payload: {
        agentType: "claude-code",
        secretName: "ANTHROPIC_API_KEY",
        value: "sk-ant-secret",
        owner: "me",
        verify: false,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().credential.id).toBe(CREDENTIAL.id);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      expect.objectContaining({ secretName: "ANTHROPIC_API_KEY", owner: "me", verify: false }),
    );
    const logged = JSON.stringify(mockLogAction.mock.calls[0][0]);
    expect(logged).toContain("agent_credential.create");
    expect(logged).not.toContain("sk-ant-secret");
  });

  it("maps a service refusal to its status and message", async () => {
    mockCreate.mockRejectedValue(
      new AgentCredentialError("Only admins add organization credentials", 403),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/credentials",
      payload: { agentType: "codex", secretName: "OPENAI_API_KEY", value: "x", owner: "workspace" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/Only admins/);
  });

  it("verifies a value without storing it", async () => {
    mockVerify.mockResolvedValue({ valid: true, detail: "3 models" });
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/credentials/verify",
      payload: { agentType: "claude-code", secretName: "ANTHROPIC_API_KEY", value: "sk" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true, detail: "3 models" });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
