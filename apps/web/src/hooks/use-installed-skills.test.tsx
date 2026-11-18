import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const list = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ api: { listInstalledSkills: list } }));
import { useInstalledSkills } from "./use-installed-skills";
import { SkillSyncError } from "@/components/settings/skill-sync-error";
function Section() {
  const { skills, loading } = useInstalledSkills();
  return (
    <div>
      {loading ? "Loading" : "Loaded"}
      {skills.map((s) => (
        <SkillSyncError key={s.id} error={s.lastSyncError} />
      ))}
    </div>
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  list.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("marketplace background sync refresh", () => {
  it("shows a delayed failure, clears it after recovery, and stops polling on unmount", async () => {
    list.mockResolvedValue({ skills: [{ id: "skill", lastSyncError: null }] });
    const { unmount } = render(<Section />);
    await act(async () => {});
    expect(screen.getByText("Loaded")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    list.mockResolvedValue({
      skills: [{ id: "skill", lastSyncError: "fatal: terminal prompts disabled" }],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("terminal prompts disabled");
    list.mockResolvedValue({ skills: [{ id: "skill", lastSyncError: null }] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    unmount();
    const calls = list.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(list).toHaveBeenCalledTimes(calls);
  });
  it("waits for a slow response before starting the next poll", async () => {
    let complete!: (result: { skills: any[] }) => void;
    list
      .mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve;
        }),
      )
      .mockResolvedValue({ skills: [] });
    render(<Section />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => {
      complete({ skills: [{ id: "slow", lastSyncError: "slow clone failed" }] });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("slow clone failed");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(list).toHaveBeenCalledTimes(2);
  });
  it("retains the last result on transient API failures and retries", async () => {
    list
      .mockResolvedValueOnce({ skills: [{ id: "skill", lastSyncError: "clone failed" }] })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ skills: [] });
    render(<Section />);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("clone failed");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
