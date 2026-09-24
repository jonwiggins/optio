import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const addLocalHostDir = vi.fn();
const removeLocalHostDir = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    addLocalHostDir: (...args: unknown[]) => addLocalHostDir(...args),
    removeLocalHostDir: (...args: unknown[]) => removeLocalHostDir(...args),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AddDirForm, HostDirList, dirsLockedReason, repoLabel } from "./host-dirs";

const laptop = {
  id: "h1",
  name: "laptop",
  state: "online",
  manageDirs: true,
  dirs: [{ path: "/Users/me/app", repoUrl: "git@github.com:acme/app.git" }],
};

beforeEach(() => {
  addLocalHostDir.mockReset();
  removeLocalHostDir.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("dirsLockedReason", () => {
  it("is null when the connected daemon takes the request", () => {
    expect(dirsLockedReason(laptop)).toBeNull();
  });

  it("says what to run instead", () => {
    expect(dirsLockedReason({ ...laptop, manageDirs: false })).toMatch(/update its CLI/);
    expect(dirsLockedReason({ ...laptop, state: "offline", manageDirs: false })).toMatch(
      /offline — start optio local up/,
    );
  });
});

describe("repoLabel", () => {
  it("shortens ssh and https remotes", () => {
    expect(repoLabel("git@github.com:acme/app.git")).toBe("acme/app");
    expect(repoLabel("https://github.com/acme/app")).toBe("acme/app");
  });
});

describe("AddDirForm", () => {
  it("adds on Enter without submitting the form around it", async () => {
    addLocalHostDir.mockResolvedValue({ host: laptop, path: "/Users/me/new" });
    const onAdded = vi.fn();
    const outerSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={outerSubmit}>
        <AddDirForm host={laptop} onAdded={onAdded} />
      </form>,
    );
    const input = screen.getByLabelText("Directory on laptop");
    fireEvent.change(input, { target: { value: "  ~/new " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(laptop, "/Users/me/new"));
    expect(addLocalHostDir).toHaveBeenCalledWith("h1", "~/new");
    expect(outerSubmit).not.toHaveBeenCalled();
    expect(input).toHaveValue("");
  });

  it("shows the machine's reason when it refuses", async () => {
    addLocalHostDir.mockRejectedValue(new Error("No such directory on this machine: /nope"));
    const onAdded = vi.fn();
    render(<AddDirForm host={laptop} onAdded={onAdded} />);
    fireEvent.change(screen.getByLabelText("Directory on laptop"), {
      target: { value: "/nope" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    expect(await screen.findByText(/No such directory/)).toBeInTheDocument();
    expect(onAdded).not.toHaveBeenCalled();
  });
});

describe("HostDirList", () => {
  it("removes a directory after confirming", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const updated = { ...laptop, dirs: [] };
    removeLocalHostDir.mockResolvedValue({ host: updated, path: "/Users/me/app" });
    const onChanged = vi.fn();
    render(<HostDirList host={laptop} onChanged={onChanged} />);
    expect(screen.getByText("acme/app")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove /Users/me/app" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(updated));
    expect(removeLocalHostDir).toHaveBeenCalledWith("h1", "/Users/me/app");
  });

  it("offers no remove button when the machine can't take the request", () => {
    render(<HostDirList host={{ ...laptop, manageDirs: false }} onChanged={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  });
});
