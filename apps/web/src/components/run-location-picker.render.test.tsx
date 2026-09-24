import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const hostsState = vi.hoisted(() => ({
  hosts: [] as any[],
  loading: false,
  replaceHost: vi.fn(),
}));
vi.mock("@/hooks/use-local-hosts", () => ({
  useLocalHosts: () => ({ ...hostsState, refetch: vi.fn() }),
}));

const addLocalHostDir = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    getAuthProviders: () => Promise.resolve({ providers: [], authDisabled: true }),
    addLocalHostDir: (...args: unknown[]) => addLocalHostDir(...args),
    removeLocalHostDir: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { RunLocationPicker, type RunLocationValue } from "./run-location-picker";

const LOCAL: RunLocationValue = {
  runTarget: "local",
  localHostId: "",
  localDir: "",
  localSessionMode: "headless",
};

const laptop = (extra: Record<string, unknown> = {}) => ({
  id: "h1",
  name: "laptop",
  state: "online",
  manageDirs: true,
  dirs: [] as Array<{ path: string; repoUrl?: string }>,
  ...extra,
});

beforeEach(() => {
  hostsState.hosts = [];
  hostsState.loading = false;
  hostsState.replaceHost.mockReset();
  addLocalHostDir.mockReset();
});

afterEach(() => cleanup());

describe("RunLocationPicker on my machine", () => {
  it("with no machine paired, shows how to pair one instead of empty dropdowns", async () => {
    render(<RunLocationPicker value={LOCAL} onChange={vi.fn()} kind="job" />);
    expect(screen.getByText(/No machine is paired yet/)).toBeInTheDocument();
    expect(await screen.findByText(/local up$/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("keeps My machine pickable while none is paired, and says why to pick it", () => {
    const onChange = vi.fn();
    render(
      <RunLocationPicker
        value={{ ...LOCAL, runTarget: "cluster" }}
        onChange={onChange}
        kind="job"
      />,
    );
    const card = screen.getByRole("button", { name: /My machine/ });
    expect(card).toBeEnabled();
    expect(card).toHaveTextContent("None paired yet — pick it to see how.");
    fireEvent.click(card);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ runTarget: "local" }));
  });

  it("offers to add a directory on a machine that has none, and selects what it adds", async () => {
    const host = laptop();
    hostsState.hosts = [host];
    const added = { ...host, dirs: [{ path: "/Users/me/notes" }] };
    addLocalHostDir.mockResolvedValue({ host: added, path: "/Users/me/notes" });
    const onChange = vi.fn();
    render(
      <RunLocationPicker value={{ ...LOCAL, localHostId: "h1" }} onChange={onChange} kind="job" />,
    );

    const input = screen.getByLabelText("Directory on laptop");
    fireEvent.change(input, { target: { value: "~/notes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ localHostId: "h1", localDir: "/Users/me/notes" }),
      ),
    );
    expect(hostsState.replaceHost).toHaveBeenCalledWith(added);
  });

  it("puts '+ Add a directory…' in the Directory list and opens the form from it", () => {
    hostsState.hosts = [laptop({ dirs: [{ path: "/Users/me/app", repoUrl: "git@x:a/b.git" }] })];
    const onChange = vi.fn();
    render(
      <RunLocationPicker
        value={{ ...LOCAL, localHostId: "h1", localDir: "/Users/me/app" }}
        onChange={onChange}
        kind="job"
      />,
    );
    expect(screen.queryByLabelText("Directory on laptop")).not.toBeInTheDocument();
    const dirSelect = screen.getAllByRole("combobox")[1];
    fireEvent.change(dirSelect, { target: { value: "__add__" } });
    expect(screen.getByLabelText("Directory on laptop")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ localDir: "__add__" }));
  });

  it("gives the command to run when the machine can't take the request", () => {
    hostsState.hosts = [laptop({ manageDirs: false, state: "offline" })];
    render(
      <RunLocationPicker value={{ ...LOCAL, localHostId: "h1" }} onChange={vi.fn()} kind="job" />,
    );
    expect(screen.getByText(/laptop is offline — start optio local up on it/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Directory on laptop")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Add a directory/ })).not.toBeInTheDocument();
  });
});
