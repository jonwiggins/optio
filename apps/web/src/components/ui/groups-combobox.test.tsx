import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { useState } from "react";

const searchGroups = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { searchGroups: (...args: unknown[]) => searchGroups(...args) },
}));

import { GroupsCombobox, addGroups, splitGroups } from "./groups-combobox";

beforeEach(() => {
  vi.useFakeTimers();
  searchGroups.mockResolvedValue({
    groups: [
      { name: "Eng-Platform", source: "ldap" },
      { name: "SRE", source: "seen" },
    ],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function Field({
  initial = [],
  onChange = () => {},
  search,
}: {
  initial?: string[];
  onChange?: (g: string[]) => void;
  search?: boolean;
}) {
  const [groups, setGroups] = useState(initial);
  return (
    <GroupsCombobox
      qualified={false}
      label="Accessible to groups"
      value={groups}
      search={search}
      onChange={(next) => {
        setGroups(next);
        onChange(next);
      }}
    />
  );
}

const flush = async () => {
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
};

describe("addGroups / splitGroups", () => {
  it("de-duplicates case-insensitively, keeping the first spelling", () => {
    expect(addGroups(["Eng"], ["eng", "SRE", "sre"])).toEqual(["Eng", "SRE"]);
    expect(splitGroups(" eng, ,sre ,")).toEqual(["eng", "sre"]);
  });
});

describe("GroupsCombobox", () => {
  it("suggests the directory's groups and adds a picked one as a chip", async () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: "Accessible to groups" });
    fireEvent.focus(input);
    await flush();
    expect(searchGroups).toHaveBeenCalledWith("");
    fireEvent.click(screen.getByRole("option", { name: /Eng-Platform/ }));
    expect(onChange).toHaveBeenLastCalledWith(["Eng-Platform"]);
    expect(screen.getByRole("button", { name: "Remove Eng-Platform" })).toBeTruthy();

    // A picked group isn't offered again.
    fireEvent.focus(input);
    await flush();
    expect(screen.queryByRole("option", { name: /Eng-Platform/ })).toBeNull();
    expect(screen.getByRole("option", { name: /SRE/ })).toBeTruthy();
  });

  it("takes names typed in full, comma-separated, on Enter", async () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: "Accessible to groups" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "data-team, ml-team" } });
    await flush();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(["data-team", "ml-team"]);
  });

  it("removes a chip", () => {
    const onChange = vi.fn();
    render(<Field initial={["eng", "sre"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove eng" }));
    expect(onChange).toHaveBeenLastCalledWith(["sre"]);
  });

  it("says why when the directory can't be searched, and still takes typed names", async () => {
    searchGroups.mockResolvedValue({ groups: [], ldapError: "connect ECONNREFUSED" });
    render(<Field />);
    fireEvent.focus(screen.getByRole("combobox", { name: "Accessible to groups" }));
    await flush();
    expect(screen.getByText(/couldn't be searched: connect ECONNREFUSED/)).toBeTruthy();
  });

  it("asks nothing with search off", async () => {
    render(<Field search={false} />);
    fireEvent.focus(screen.getByRole("combobox", { name: "Accessible to groups" }));
    await flush();
    expect(searchGroups).not.toHaveBeenCalled();
    expect(
      screen.getByRole("combobox", { name: "Accessible to groups" }).getAttribute("placeholder"),
    ).toMatch(/as your directory spells it/);
  });
});

describe("qualified membership groups", () => {
  it("keeps same-named groups from different authorities distinct", async () => {
    const oidc = "sso:oidc:" + "a".repeat(64) + ":engineering";
    const ldap = "sso:ldap:" + "b".repeat(64) + ":engineering";
    searchGroups.mockResolvedValue({
      groups: [
        { name: oidc, source: "seen" },
        { name: ldap, source: "ldap" },
      ],
    });
    const changed = vi.fn();
    render(<GroupsCombobox label="Membership" value={[]} onChange={changed} />);
    const input = screen.getByRole("combobox", { name: "Membership" });
    fireEvent.focus(input);
    await flush();
    fireEvent.click(screen.getByRole("option", { name: /engineering \(oidc/ }));
    expect(changed).toHaveBeenCalledWith([oidc]);
    searchGroups.mockResolvedValue({ groups: [] });
    fireEvent.change(input, { target: { value: "unqualified" } });
    await flush();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
