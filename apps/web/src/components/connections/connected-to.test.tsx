import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

afterEach(cleanup);
import type { WorkEnvironmentEntry } from "@optio/shared";
import { ConnectedTo } from "./connected-to";

const entry = (over: Partial<WorkEnvironmentEntry>): WorkEnvironmentEntry => ({
  kind: "connection",
  id: "x",
  name: "X",
  icon: null,
  parts: ["tools", "credentials"],
  providerName: "Linear",
  providerSlug: "linear",
  enabled: true,
  scope: "workspace",
  default: false,
  ownerUserId: null,
  ownerName: null,
  ...over,
});

const aws = entry({ id: "aws", name: "Acme AWS", icon: "aws", providerName: "AWS", default: true });
const mine = entry({ id: "lin", name: "Jon's Linear", ownerUserId: "jon", ownerName: "Jon" });
const sams = entry({ id: "not", name: "Sam's Notion", ownerUserId: "sam", ownerName: "Sam" });
const secret = entry({
  kind: "secret",
  id: "STRIPE_KEY",
  name: "STRIPE_KEY",
  parts: ["credentials"],
  providerName: "Secret",
  providerSlug: null,
});

function setup(on: Set<string>, props: Partial<React.ComponentProps<typeof ConnectedTo>> = {}) {
  const onToggle = vi.fn();
  render(
    <ConnectedTo
      entries={[aws, mine, sams, secret]}
      isOn={(e) => on.has(e.id)}
      onToggle={onToggle}
      viewerId="jon"
      workOwner="me"
      hasRepo
      onConnectNew={vi.fn()}
      {...props}
    />,
  );
  return { onToggle };
}

describe("ConnectedTo", () => {
  it("shows connected chips, tags defaults, and keeps a switched-off default visible with an undo", () => {
    const { onToggle } = setup(new Set(["lin"]));
    expect(screen.getAllByTestId("connected-chip")).toHaveLength(1);
    expect(screen.getByText("Jon's Linear")).toBeTruthy();
    // The AWS default is off: struck through with a way back.
    const off = screen.getByTestId("connected-chip-off");
    expect(within(off).getByText("Acme AWS")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Turn Acme AWS back on"));
    expect(onToggle).toHaveBeenCalledWith(aws, true);
    expect(screen.getByTestId("connected-to-summary").textContent).toContain("1 turned off");
  });

  it("opens a grouped list with subtext, and toggles a row", () => {
    const { onToggle } = setup(new Set(["aws"]));
    fireEvent.click(screen.getByLabelText("Add a connection"));
    const list = screen.getByRole("listbox");
    expect(within(list).getByRole("group", { name: "From the repo's defaults" })).toBeTruthy();
    expect(within(list).getByRole("group", { name: "Private" })).toBeTruthy();
    expect(within(list).getByRole("group", { name: "Organization" })).toBeTruthy();
    expect(within(list).getByRole("group", { name: "Other people's" })).toBeTruthy();
    expect(within(list).getByText("Private · tools + credentials · Linear")).toBeTruthy();
    expect(within(list).getByText("Organization · credentials only · Secret")).toBeTruthy();
    fireEvent.click(within(list).getByRole("option", { name: /Jon's Linear/ }));
    expect(onToggle).toHaveBeenCalledWith(mine, true);
    // Someone else's private row can't be picked, and says why.
    const theirs = within(list).getByRole("option", { name: /Sam's Notion/ });
    expect(theirs.hasAttribute("disabled")).toBe(true);
    expect(theirs.getAttribute("title")).toBe("Only Sam's work can use this");
  });

  it("disables the viewer's private rows for organization work", () => {
    setup(new Set(), { workOwner: "workspace" });
    fireEvent.click(screen.getByLabelText("Add a connection"));
    const row = screen.getByRole("option", { name: /Jon's Linear/ });
    expect(row.hasAttribute("disabled")).toBe(true);
    expect(row.getAttribute("title")).toMatch(/Switch the owner to Private/);
  });

  it("filters by search and offers to connect something new", () => {
    const onConnectNew = vi.fn();
    setup(new Set(), { onConnectNew });
    fireEvent.click(screen.getByLabelText("Add a connection"));
    fireEvent.change(screen.getByLabelText("Search connections"), { target: { value: "stripe" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.click(screen.getByText("Connect something new…"));
    expect(onConnectNew).toHaveBeenCalled();
  });

  it("shows only the reason when the work runs on a machine", () => {
    setup(new Set(["aws"]), { disabledReason: "Uses your machine's own logins." });
    expect(screen.getByText("Uses your machine's own logins.")).toBeTruthy();
    expect(screen.queryByTestId("connected-chip")).toBeNull();
  });
});
