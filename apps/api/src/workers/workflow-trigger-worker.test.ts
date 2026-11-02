import { describe, it, expect, vi, beforeEach } from "vitest";
const mockDue = vi.fn(),
  mockAdvance = vi.fn(),
  mockEnqueue = vi.fn(),
  mockDrain = vi.fn(),
  mockPaused = vi.fn();
const tx = { transaction: "test" };
vi.mock("../db/client.js", () => ({
  db: { transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(tx) },
}));
vi.mock("bullmq", () => ({ Queue: vi.fn(), Worker: vi.fn() }));
vi.mock("../services/redis-config.js", () => ({ getBullMQOptions: () => ({}) }));
vi.mock("../services/repeat-jobs.js", () => ({ scheduleRepeat: vi.fn() }));
vi.mock("../services/poller-lease.js", () => ({ underPollerLease: vi.fn() }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../services/trigger-service.js", () => ({
  listDueScheduleTriggers: (...a: unknown[]) => mockDue(...a),
  advanceScheduleCas: (...a: unknown[]) => mockAdvance(...a),
}));
vi.mock("../services/trigger-delivery.js", () => ({
  enqueueOccurrence: (...a: unknown[]) => mockEnqueue(...a),
  drainTriggerDeliveries: () => mockDrain(),
}));
vi.mock("../services/agent-work-pause.js", () => ({
  agentWorkPauseHold: () => mockPaused(),
}));
import { checkDueScheduleTriggers } from "./workflow-trigger-worker.js";
const trigger = {
  id: "t",
  targetType: "job",
  targetId: "w",
  nextFireAt: new Date("2026-10-01"),
  config: { cronExpression: "0 0 * * *" },
  paramMapping: { name: "value" },
};
beforeEach(() => {
  vi.clearAllMocks();
  mockDue.mockResolvedValue([trigger]);
  mockAdvance.mockResolvedValue(true);
  mockEnqueue.mockResolvedValue({ id: "occurrence" });
  mockDrain.mockResolvedValue(undefined);
  mockPaused.mockResolvedValue(null);
});
describe("schedule delivery", () => {
  it("advances and persists with the same transaction and a stable tick identity", async () => {
    expect(await checkDueScheduleTriggers()).toBe(1);
    expect(mockAdvance).toHaveBeenCalledWith("t", "0 0 * * *", trigger.nextFireAt, tx, undefined);
    expect(mockEnqueue).toHaveBeenCalledWith(
      trigger,
      { source: "schedule", params: { name: "value" } },
      "schedule:t:2026-10-01T00:00:00.000Z",
      tx,
    );
    expect(mockDrain).toHaveBeenCalledOnce();
  });
  it("does not enqueue after losing the schedule CAS", async () => {
    mockAdvance.mockResolvedValue(false);
    expect(await checkDueScheduleTriggers()).toBe(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
  it("preserves the timezone when advancing a scheduled occurrence", async () => {
    mockDue.mockResolvedValue([
      { ...trigger, config: { ...trigger.config, timezone: "America/Denver" } },
    ]);
    expect(await checkDueScheduleTriggers()).toBe(1);
    expect(mockAdvance).toHaveBeenCalledWith(
      "t",
      "0 0 * * *",
      trigger.nextFireAt,
      tx,
      "America/Denver",
    );
  });
  it("leaves dispatch to the durable worker after saving the occurrence", async () => {
    mockDrain.mockRejectedValue(Error("restart"));
    await expect(checkDueScheduleTriggers()).rejects.toThrow("restart");
    expect(mockEnqueue).toHaveBeenCalledOnce();
  });
  it("continues other schedules after a transactional persistence failure", async () => {
    mockDue.mockResolvedValue([trigger, { ...trigger, id: "second" }]);
    mockEnqueue.mockRejectedValueOnce(Error("database failure"));
    expect(await checkDueScheduleTriggers()).toBe(1);
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
  });
  it("leaves every schedule due while agent work is paused", async () => {
    mockPaused.mockResolvedValue("Agent work is paused by an administrator: upgrade");
    expect(await checkDueScheduleTriggers()).toBe(0);
    expect(mockDue).not.toHaveBeenCalled();
    expect(mockAdvance).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
  it("ignores schedules without a cron expression", async () => {
    mockDue.mockResolvedValue([{ ...trigger, config: {} }]);
    expect(await checkDueScheduleTriggers()).toBe(0);
    expect(mockAdvance).not.toHaveBeenCalled();
  });
});
