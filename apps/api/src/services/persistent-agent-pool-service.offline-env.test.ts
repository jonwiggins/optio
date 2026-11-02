import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  destroy: vi.fn(),
  status: vi.fn(),
  insertPod: vi.fn(),
  markPodReady: vi.fn(),
  markPodError: vi.fn(),
  deletePod: vi.fn(),
  provisioningAbandoned: vi.fn(),
  waitForProvisioning: vi.fn(),
  podHandle: (pod: { podId: string | null; podName: string }) => ({
    id: pod.podId ?? pod.podName,
    name: pod.podName,
  }),
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
vi.mock("./pod-isolation.js", () => ({
  podIsolationKey: () => "boundary",
  workCredentialProfile: () => null,
}));

import { acquirePodForAgent } from "./persistent-agent-pool-service.js";
import { AGENT_OFFLINE_ENV } from "./agent-offline-env.js";

describe("persistent agent pod: offline baseline (OPTIO_AGENT_OFFLINE)", () => {
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
  });
  afterEach(() => vi.unstubAllEnvs());

  it("leaves the pod env alone by default", async () => {
    await acquirePodForAgent("agent-1");
    expect(mocks.create.mock.calls[0][0].env).not.toHaveProperty("DISABLE_TELEMETRY");
  });

  it("adds the baseline when on", async () => {
    vi.stubEnv("OPTIO_AGENT_OFFLINE", "true");
    await acquirePodForAgent("agent-1");
    expect(mocks.create.mock.calls[0][0].env).toEqual({
      ...AGENT_OFFLINE_ENV,
      OPTIO_PERSISTENT_AGENT_ID: "agent-1",
      OPTIO_PERSISTENT_AGENT_SLUG: "agent",
      OPTIO_AGENT_RUNTIME: "claude-code",
    });
  });
});
