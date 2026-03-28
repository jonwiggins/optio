import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRuntime = {
  create: vi.fn(),
  status: vi.fn(),
  logs: vi.fn(),
  destroy: vi.fn(),
  ping: vi.fn(),
};

vi.mock("@optio/container-runtime", () => ({
  createRuntime: vi.fn(() => mockRuntime),
}));

vi.mock("@optio/shared", async () => {
  const actual = await vi.importActual("@optio/shared");
  return {
    ...actual,
    DEFAULT_AGENT_IMAGE: "optio-agent:latest",
  };
});

import {
  getRuntime,
  launchAgentContainer,
  getContainerStatus,
  streamContainerLogs,
  destroyAgentContainer,
  checkRuntimeHealth,
} from "./container-service.js";

describe("container-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getRuntime", () => {
    it("creates and caches runtime", () => {
      const runtime = getRuntime();
      expect(runtime).toBeDefined();
      // Calling again returns same instance
      const runtime2 = getRuntime();
      expect(runtime2).toBe(runtime);
    });
  });

  describe("launchAgentContainer", () => {
    it("creates container with correct spec", async () => {
      const handle = { containerId: "c-1" };
      mockRuntime.create.mockResolvedValue(handle);

      const result = await launchAgentContainer({
        taskId: "task-1",
        agentType: "claude-code",
        command: ["claude", "-p", "do stuff"],
        env: { KEY: "value" },
      });

      expect(result).toEqual(handle);
      expect(mockRuntime.create).toHaveBeenCalledWith(
        expect.objectContaining({
          image: "optio-agent:latest",
          workDir: "/workspace",
          labels: {
            "optio.task-id": "task-1",
            "optio.agent-type": "claude-code",
            "managed-by": "optio",
          },
        }),
      );
    });

    it("uses custom image when provided", async () => {
      mockRuntime.create.mockResolvedValue({ containerId: "c-2" });

      await launchAgentContainer({
        taskId: "task-1",
        agentType: "claude-code",
        command: ["echo"],
        env: {},
        image: "custom-image:v1",
      });

      expect(mockRuntime.create).toHaveBeenCalledWith(
        expect.objectContaining({
          image: "custom-image:v1",
        }),
      );
    });
  });

  describe("getContainerStatus", () => {
    it("delegates to runtime", async () => {
      const status = { state: "running" };
      mockRuntime.status.mockResolvedValue(status);

      const result = await getContainerStatus({ containerId: "c-1" } as any);
      expect(result).toEqual(status);
    });
  });

  describe("streamContainerLogs", () => {
    it("delegates to runtime", () => {
      const logs = (async function* () {
        yield "line 1";
      })();
      mockRuntime.logs.mockReturnValue(logs);

      const result = streamContainerLogs({ containerId: "c-1" } as any, { follow: true });
      expect(result).toBe(logs);
    });
  });

  describe("destroyAgentContainer", () => {
    it("delegates to runtime", async () => {
      mockRuntime.destroy.mockResolvedValue(undefined);

      await destroyAgentContainer({ containerId: "c-1" } as any);
      expect(mockRuntime.destroy).toHaveBeenCalled();
    });
  });

  describe("checkRuntimeHealth", () => {
    it("returns true when healthy", async () => {
      mockRuntime.ping.mockResolvedValue(true);

      const result = await checkRuntimeHealth();
      expect(result).toBe(true);
    });

    it("returns false when unhealthy", async () => {
      mockRuntime.ping.mockResolvedValue(false);

      const result = await checkRuntimeHealth();
      expect(result).toBe(false);
    });
  });
});
