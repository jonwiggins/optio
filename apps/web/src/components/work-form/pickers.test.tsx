import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { useState } from "react";

const api = vi.hoisted(() => ({
  listRepoBranches: vi.fn(),
  searchPullRequests: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { BranchPicker, PrPicker } from "./work-form";

const BRANCHES = {
  branches: [
    { name: "develop", default: true, protected: true },
    { name: "release/1.0", default: false, protected: false },
    { name: "release/1.1", default: false, protected: false },
  ],
  defaultBranch: "develop",
};

const MR = {
  id: 12,
  number: 12,
  title: "Fix login",
  url: "https://gitlab.example/g/p/-/merge_requests/12",
  state: "open",
  author: "alice",
  headBranch: "bug/login",
  headRepo: null,
  baseBranch: "develop",
  updatedAt: "2024-01-01T00:00:00Z",
  repo: {
    id: "repo-1",
    fullName: "g/p",
    repoUrl: "https://gitlab.example/g/p",
    gitPlatform: "gitlab",
  },
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

function PrHarness() {
  const [picked, setPicked] = useState<any>(null);
  return (
    <div>
      <PrPicker
        repoId="repo-1"
        platform="gitlab"
        picked={picked}
        onPick={setPicked}
        onClear={() => setPicked(null)}
      />
      <output data-testid="branch">{picked?.headBranch ?? ""}</output>
    </div>
  );
}

const mrBox = () => screen.getByRole("combobox", { name: "Merge request" }) as HTMLInputElement;

describe("PrPicker", () => {
  it("searches the repo's open merge requests with q and hands back the picked one", async () => {
    api.searchPullRequests.mockResolvedValue({
      pullRequests: [MR, { ...MR, number: 13, title: "Other", url: "u13", headBranch: "other" }],
    });
    render(<PrHarness />);

    fireEvent.focus(mrBox());
    await settle(0);
    expect(api.searchPullRequests).toHaveBeenCalledWith({
      repoId: "repo-1",
      q: undefined,
      limit: 20,
    });
    const rows = screen.getAllByRole("option");
    expect(rows[0].textContent).toContain("!12 Fix login");
    expect(rows[0].textContent).toContain("@alice · bug/login → develop");

    api.searchPullRequests.mockResolvedValue({ pullRequests: [MR] });
    fireEvent.change(mrBox(), { target: { value: "login" } });
    await settle();
    expect(api.searchPullRequests).toHaveBeenLastCalledWith({
      repoId: "repo-1",
      q: "login",
      limit: 20,
    });
    expect(screen.getAllByRole("option")).toHaveLength(1);

    fireEvent.click(screen.getByRole("option"));
    expect(screen.getByTestId("branch").textContent).toBe("bug/login");
    expect(mrBox().value).toBe("!12 Fix login");

    fireEvent.click(screen.getByRole("button", { name: "Clear merge request" }));
    expect(screen.getByTestId("branch").textContent).toBe("");
  });

  it("leaves out pull requests from a fork", async () => {
    api.searchPullRequests.mockResolvedValue({
      pullRequests: [MR, { ...MR, number: 14, url: "u14", headRepo: "someone/p" }],
    });
    render(<PrHarness />);
    fireEvent.focus(mrBox());
    await settle(0);
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });
});
