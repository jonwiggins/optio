import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { useState } from "react";

const api = vi.hoisted(() => ({
  listRepoBranches: vi.fn(),
  searchPullRequests: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { BranchPicker } from "./work-form";

const BRANCHES = {
  branches: [
    { name: "develop", default: true, protected: true },
    { name: "release/1.0", default: false, protected: false },
    { name: "release/1.1", default: false, protected: false },
  ],
  defaultBranch: "develop",
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Let the debounce fire and the mocked fetch resolve. */
async function settle(ms = 250) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function BranchHarness({ repoId }: { repoId: string | null }) {
  const [value, setValue] = useState("develop");
  return (
    <div>
      <BranchPicker repoId={repoId} value={value} onChange={setValue} />
      <output data-testid="value">{value}</output>
    </div>
  );
}

const branchBox = () => screen.getByRole("combobox", { name: "Branch" }) as HTMLInputElement;

describe("BranchPicker", () => {
  it("lists the repo's branches on focus, default first, and searches with q as you type", async () => {
    api.listRepoBranches.mockResolvedValue(BRANCHES);
    render(<BranchHarness repoId="repo-1" />);

    fireEvent.focus(branchBox());
    await settle(0);
    expect(api.listRepoBranches).toHaveBeenCalledWith("repo-1", { q: undefined, limit: 30 });
    const rows = screen.getAllByRole("option");
    expect(rows[0].textContent).toBe("developdefault");
    expect(rows).toHaveLength(3);

    api.listRepoBranches.mockResolvedValue({
      branches: BRANCHES.branches.filter((b) => b.name.startsWith("release")),
      defaultBranch: "develop",
    });
    fireEvent.change(branchBox(), { target: { value: "rel" } });
    await settle();
    expect(api.listRepoBranches).toHaveBeenLastCalledWith("repo-1", { q: "rel", limit: 30 });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "release/1.0",
      "release/1.1",
    ]);

    fireEvent.keyDown(branchBox(), { key: "ArrowDown" });
    fireEvent.keyDown(branchBox(), { key: "ArrowDown" });
    fireEvent.keyDown(branchBox(), { key: "Enter" });
    expect(screen.getByTestId("value").textContent).toBe("release/1.1");
    expect(branchBox().value).toBe("release/1.1");
  });

  it("keeps a typed name when nothing matches, and shows the platform's error as a hint", async () => {
    api.listRepoBranches.mockResolvedValue({
      branches: [],
      defaultBranch: "develop",
      error: "No GitLab token available",
    });
    render(<BranchHarness repoId="repo-1" />);

    fireEvent.focus(branchBox());
    fireEvent.change(branchBox(), { target: { value: "feature/typed" } });
    await settle();
    const list = screen.getByRole("listbox");
    expect(list.textContent).toContain("No branch matches “feature/typed”");
    expect(list.textContent).toContain("No GitLab token available");

    fireEvent.keyDown(branchBox(), { key: "Enter" });
    expect(screen.getByTestId("value").textContent).toBe("feature/typed");
  });

  it("is a plain text field for a checkout Optio can't ask about", async () => {
    render(<BranchHarness repoId={null} />);
    fireEvent.focus(branchBox());
    await settle(0);
    expect(api.listRepoBranches).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.change(branchBox(), { target: { value: "main" } });
    fireEvent.keyDown(branchBox(), { key: "Enter" });
    expect(screen.getByTestId("value").textContent).toBe("main");
  });
});
