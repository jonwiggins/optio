import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPublish = vi.fn().mockResolvedValue(1);
const mockRedisInstance = {
  publish: mockPublish,
};

vi.mock("ioredis", () => ({
  Redis: vi.fn(() => mockRedisInstance),
}));

vi.mock("./redis-config.js", () => ({
  redisConnectionUrl: "redis://localhost:6379",
  redisTlsOptions: undefined,
}));

import {
  publishEvent,
  publishSessionEvent,
  publishWorkflowRunEvent,
  createSubscriber,
} from "./event-bus.js";

describe("event-bus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("publishEvent", () => {
    it("publishes to the global events channel", async () => {
      await publishEvent({ type: "task:updated", taskId: "t-1" } as any);

      expect(mockPublish).toHaveBeenCalledWith(
        "optio:events",
        expect.stringContaining('"type":"task:updated"'),
      );
    });

    it("also publishes to task-specific channel when taskId present", async () => {
      await publishEvent({ type: "task:updated", taskId: "t-1" } as any);

      expect(mockPublish).toHaveBeenCalledWith(
        "optio:task:t-1",
        expect.stringContaining('"taskId":"t-1"'),
      );
      expect(mockPublish).toHaveBeenCalledTimes(2);
    });

    it("does not publish to task channel when no taskId", async () => {
      await publishEvent({ type: "session:created" } as any);

      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledWith("optio:events", expect.any(String));
    });
  });

  describe("publishSessionEvent", () => {
    it("publishes to session-specific channel", async () => {
      await publishSessionEvent("sess-1", { type: "session:ended" } as any);

      expect(mockPublish).toHaveBeenCalledWith(
        "optio:session:sess-1",
        expect.stringContaining('"type":"session:ended"'),
      );
    });
  });

  describe("publishWorkflowRunEvent", () => {
    it("publishes to the global events channel", async () => {
      await publishWorkflowRunEvent({
        type: "workflow_run:state_changed",
        workflowRunId: "wr-1",
        workflowId: "w-1",
        fromState: "queued" as any,
        toState: "running" as any,
        timestamp: "2026-01-01T00:00:00Z",
      });

      expect(mockPublish).toHaveBeenCalledWith(
        "optio:events",
        expect.stringContaining('"type":"workflow_run:state_changed"'),
      );
    });

    it("also publishes to workflow-run-specific channel", async () => {
      await publishWorkflowRunEvent({
        type: "workflow_run:log",
        workflowRunId: "wr-1",
        stream: "stdout",
        content: "Hello",
        timestamp: "2026-01-01T00:00:00Z",
      });

      expect(mockPublish).toHaveBeenCalledWith(
        "optio:workflow-run:wr-1",
        expect.stringContaining('"workflowRunId":"wr-1"'),
      );
      expect(mockPublish).toHaveBeenCalledTimes(2);
    });

    it("does not publish to workflow-run channel when no workflowRunId", async () => {
      await publishWorkflowRunEvent({
        type: "session:created",
      } as any);

      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledWith("optio:events", expect.any(String));
    });
  });

  describe("createSubscriber", () => {
    it("creates a new Redis instance", () => {
      const subscriber = createSubscriber();
      expect(subscriber).toBeDefined();
    });
  });
});
