import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  session: vi.fn(),
  terminal: vi.fn(),
  pod: vi.fn(),
  status: vi.fn(),
  turn: vi.fn(),
  online: vi.fn(),
}));
vi.mock("./interactive-session-service.js", () => ({ getSession: mock.session }));
vi.mock("./local-terminal-service.js", () => ({ getTerminal: mock.terminal }));
vi.mock("./local-relay.js", () => ({ isHostOnline: mock.online }));
vi.mock("./agent-pod-pool.js", () => ({ getPod: mock.pod, podHandle: (p: unknown) => p }));
vi.mock("./container-service.js", () => ({ getRuntime: () => ({ status: mock.status }) }));
vi.mock("./session-turn-service.js", () => ({ latestSessionTurn: mock.turn }));
import { sessionRecovery } from "./session-recovery-service.js";
beforeEach(() => {
  vi.resetAllMocks();
  mock.session.mockResolvedValue({
    state: "active",
    podId: "p",
    createdAt: new Date("2026-10-06T12:00:00Z"),
  });
  mock.pod.mockResolvedValue({ podName: "p", isolationKey: "isolated", managedBy: "statefulset" });
  mock.status.mockResolvedValue({ state: "running" });
});
it("reports process loss after a pod restart even when the replacement is running", async () => {
  mock.status.mockResolvedValue({
    state: "running",
    startedAt: new Date("2026-10-06T12:01:00Z"),
  });
  expect(await sessionRecovery("pod", "s")).toMatchObject({
    state: "resumable",
    automaticReplay: false,
    message: expect.stringContaining("previous processes stopped"),
  });
  mock.pod.mockResolvedValue({ podName: "p", isolationKey: "isolated", managedBy: "bare" });
  expect(await sessionRecovery("pod", "s")).toMatchObject({ state: "lost" });
  mock.status.mockResolvedValue({
    state: "running",
    startedAt: new Date("2026-10-06T11:59:00Z"),
  });
  expect(await sessionRecovery("pod", "s")).toMatchObject({ state: "live" });
});
it("distinguishes transient status loss, recoverable storage and an interrupted turn", async () => {
  mock.status.mockRejectedValueOnce(new Error("Kubernetes temporarily unavailable"));
  expect(await sessionRecovery("pod", "s")).toMatchObject({
    state: "reconnecting",
    automaticReplay: false,
  });
  mock.status.mockResolvedValueOnce({ state: "pending" });
  expect(await sessionRecovery("pod", "s")).toMatchObject({ state: "reconnecting" });
  mock.turn.mockResolvedValueOnce({ state: "interrupted" });
  expect(await sessionRecovery("pod", "s")).toMatchObject({ state: "resumable" });
});
it("reports a lost ephemeral pod and retains ended history", async () => {
  mock.pod.mockResolvedValue({ podName: "p", isolationKey: "isolated", managedBy: "bare" });
  mock.status.mockResolvedValue({ state: "failed" });
  expect(await sessionRecovery("pod", "s")).toMatchObject({
    state: "lost",
    automaticReplay: false,
  });
  mock.session.mockResolvedValue({ state: "ended" });
  expect(await sessionRecovery("pod", "s")).toMatchObject({ state: "ended" });
});
it("waits for an offline Local daemon and offers conversation resume after process exit", async () => {
  mock.terminal.mockResolvedValue({ state: "running", hostId: "h" });
  mock.online.mockReturnValue(false);
  expect(await sessionRecovery("local", "s")).toMatchObject({ state: "reconnecting" });
  mock.terminal.mockResolvedValue({ state: "exited", agentSessionId: "conversation" });
  expect(await sessionRecovery("local", "s")).toMatchObject({
    state: "resumable",
    automaticReplay: false,
  });
});
