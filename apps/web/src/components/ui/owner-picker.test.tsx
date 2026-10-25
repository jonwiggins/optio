import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { OwnerPicker } from "./owner-picker";
import type { PickedOwner } from "@/lib/owner";

const T1 = "11111111-2222-4333-8444-555555555555";
const T2 = "66666666-7777-4888-9999-000000000000";
const teams = [
  { id: T1, name: "Platform" },
  { id: T2, name: "Mobile" },
];

afterEach(cleanup);

describe("OwnerPicker", () => {
  it("offers Organization and Private alone when the viewer has no teams", () => {
    render(<OwnerPicker value="organization" onChange={() => {}} what="secret" />);
    expect(screen.getByRole("button", { name: "Organization" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Private" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Team" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Team" })).toBeNull();
  });

  it("adds Team, and picking it hands back the first team as team:<id>", () => {
    const onChange = vi.fn<(v: PickedOwner) => void>();
    render(<OwnerPicker value="organization" onChange={onChange} what="prompt" teams={teams} />);
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    expect(onChange).toHaveBeenCalledWith(`team:${T1}`);
  });

  it("with a team picked, shows a select of the viewer's teams and switches between them", () => {
    const onChange = vi.fn<(v: PickedOwner) => void>();
    render(<OwnerPicker value={`team:${T1}`} onChange={onChange} what="prompt" teams={teams} />);
    expect(screen.getByRole("button", { name: "Team" })).toHaveAttribute("aria-pressed", "true");
    const select = screen.getByRole("combobox", { name: "Team" }) as HTMLSelectElement;
    expect(select.value).toBe(T1);
    fireEvent.change(select, { target: { value: T2 } });
    expect(onChange).toHaveBeenCalledWith(`team:${T2}`);
    expect(
      screen.getByText(/Everyone in the team sees and can use this prompt/),
    ).toBeInTheDocument();
  });

  it("keeps a saved row's team the viewer isn't in", () => {
    render(
      <OwnerPicker
        value={`team:${T2}`}
        onChange={() => {}}
        what="prompt"
        teams={[teams[0]]}
        disabledReason="A saved prompt keeps its scope"
      />,
    );
    const select = screen.getByRole("combobox", { name: "Team" }) as HTMLSelectElement;
    expect(select.value).toBe(T2);
    expect(select).toBeDisabled();
  });

  it("disables Organization with the reason when the viewer can't make one", () => {
    render(
      <OwnerPicker
        value="private"
        onChange={() => {}}
        what="secret"
        canOrg={false}
        teams={teams}
      />,
    );
    const org = screen.getByRole("button", { name: "Organization" });
    expect(org).toBeDisabled();
    expect(org).toHaveAttribute("title", "Only an admin can make this secret the organization's");
    expect(screen.getByRole("button", { name: "Team" })).not.toBeDisabled();
  });
});
