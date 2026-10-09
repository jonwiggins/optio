import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  destroy: vi.fn(),
  insertPod: vi.fn(),
  markPodReady: vi.fn(),
  markPodError: vi.fn(),
  where: vi.fn(),
}));
vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: mocks.where,
    delete: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  },
}));
vi.mock("./container-service.js", () => ({ getRuntime: () => mocks }));
vi.mock("./agent-pod-pool.js", () => mocks);
vi.mock("./repo-pool-service.js", () => ({ resolveImage: () => "optio-agent:latest" }));
vi.mock("../logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import { acquirePodForAgent } from "./persistent-agent-pool-service.js";

describe("persistent agent node placement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.where.mockResolvedValue([
      { id: "agent-1", slug: "agent", podLifecycle: "on-demand", agentRuntime: "claude-code" },
    ]);
    mocks.insertPod.mockResolvedValue({ id: "pod-1" });
    mocks.create.mockResolvedValue({ id: "runtime-id", name: "agent-pod" });
    mocks.markPodReady.mockResolvedValue({
      id: "pod-1",
      poolKey: "agent-1",
      podName: "agent-pod",
      state: "ready",
    });
    vi.stubEnv("OPTIO_AGENT_NODE_SELECTOR", JSON.stringify({ workload: "agent" }));
    vi.stubEnv(
      "OPTIO_AGENT_TOLERATIONS",
      JSON.stringify([{ key: "agent", operator: "Exists", effect: "NoSchedule" }]),
    );
  });
  afterEach(() => vi.unstubAllEnvs());

  it("passes placement to the pod spec", async () => {
    await acquirePodForAgent("agent-1");
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeSelector: { workload: "agent" },
        tolerations: [{ key: "agent", operator: "Exists", effect: "NoSchedule" }],
      }),
    );
  });

  it("omits placement when unset", async () => {
    vi.stubEnv("OPTIO_AGENT_NODE_SELECTOR", undefined);
    vi.stubEnv("OPTIO_AGENT_TOLERATIONS", undefined);
    await acquirePodForAgent("agent-1");
    expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("nodeSelector");
    expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("tolerations");
  });

  it.each(["OPTIO_AGENT_NODE_SELECTOR", "OPTIO_AGENT_TOLERATIONS"])(
    "rejects malformed %s before creating a pod",
    async (name) => {
      vi.stubEnv(name, "{invalid");
      await expect(acquirePodForAgent("agent-1")).rejects.toThrow(`Invalid JSON in ${name}`);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.markPodError).toHaveBeenCalledWith("pod-1", expect.any(Error));
    },
  );
});
