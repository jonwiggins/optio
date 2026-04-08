import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config and credentials stores
vi.mock("../config/config-store.js", () => ({
  loadConfig: () => ({
    currentHost: "test.example.com",
    hosts: {
      "test.example.com": {
        server: "https://test.example.com",
        workspaceId: "ws-1",
      },
    },
  }),
  getServerUrl: (_config: unknown, flag?: string) => flag ?? "https://test.example.com",
}));

vi.mock("../config/credentials-store.js", () => ({
  loadCredentials: () => ({
    hosts: {
      "test.example.com": {
        token: "optio_pat_test123",
        tokenId: "key-1",
        user: { id: "u-1", email: "test@example.com", displayName: "Test" },
      },
    },
  }),
}));

import { ApiClient } from "../api/client.js";
import { ApiError, NetworkError } from "../api/errors.js";

describe("ApiClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds with server URL from config", () => {
    const client = new ApiClient();
    expect(client.serverUrl).toBe("https://test.example.com");
  });

  it("uses flag server URL over config", () => {
    const client = new ApiClient({ server: "https://custom.com" });
    expect(client.serverUrl).toBe("https://custom.com");
  });

  it("prefers apiKey flag over credentials file", () => {
    const client = new ApiClient({ apiKey: "optio_pat_flagtoken" });
    expect(client.getToken()).toBe("optio_pat_flagtoken");
  });

  it("uses token from credentials when no flag", () => {
    const client = new ApiClient();
    expect(client.getToken()).toBe("optio_pat_test123");
  });

  it("prefers OPTIO_TOKEN env var over credentials file", () => {
    const origEnv = process.env.OPTIO_TOKEN;
    process.env.OPTIO_TOKEN = "optio_pat_envtoken";
    try {
      const client = new ApiClient();
      expect(client.getToken()).toBe("optio_pat_envtoken");
    } finally {
      if (origEnv === undefined) {
        delete process.env.OPTIO_TOKEN;
      } else {
        process.env.OPTIO_TOKEN = origEnv;
      }
    }
  });

  it("throws ApiError on non-OK response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({ error: "Task not found" }),
    });

    const client = new ApiClient();
    await expect(client.get("/api/tasks/nonexistent")).rejects.toThrow(ApiError);
  });

  it("throws NetworkError when fetch fails", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const client = new ApiClient();
    await expect(client.get("/api/health")).rejects.toThrow(NetworkError);
  });

  it("sends Authorization and workspace headers", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => '{"ok": true}',
      });
    });

    const client = new ApiClient();
    await client.get("/api/health");

    expect(capturedHeaders["Authorization"]).toBe("Bearer optio_pat_test123");
    expect(capturedHeaders["x-workspace-id"]).toBe("ws-1");
  });

  it("generates correct WebSocket URL", () => {
    const client = new ApiClient();
    expect(client.getWsUrl("/ws/logs/task-1")).toBe("wss://test.example.com/ws/logs/task-1");
  });
});

describe("ApiError", () => {
  it("maps 401 to EXIT_AUTH", () => {
    const err = new ApiError(401, { error: "Unauthorized" });
    expect(err.exitCode).toBe(2);
  });

  it("maps 403 to EXIT_FORBIDDEN", () => {
    const err = new ApiError(403, { error: "Forbidden" });
    expect(err.exitCode).toBe(3);
  });

  it("maps 400 to EXIT_VALIDATION", () => {
    const err = new ApiError(400, { error: "Bad Request" });
    expect(err.exitCode).toBe(5);
  });

  it("maps 500 to EXIT_FAILURE", () => {
    const err = new ApiError(500, { error: "Internal" });
    expect(err.exitCode).toBe(1);
  });
});
