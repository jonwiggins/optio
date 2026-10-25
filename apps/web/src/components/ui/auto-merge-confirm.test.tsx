import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { AutoMergeConfirmedNote, useAutoMergeConfirm } from "./auto-merge-confirm";
import { useDeploymentSwitchesStore } from "@/hooks/use-deployment-switches";

/** The deployment's "Automatic merging needs a confirmation" switch. */
const confirmation = (on: boolean) =>
  useDeploymentSwitchesStore.setState({ mergeConfirmation: on, loaded: true });

beforeAll(() => {
  // jsdom has no <dialog> modality.
  HTMLDialogElement.prototype.showModal ??= function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function () {
    this.removeAttribute("open");
  };
});

afterEach(() => {
  cleanup();
  useDeploymentSwitchesStore.getState().reset();
});

function Harness({ onChange }: { onChange: (on: boolean, confirmed: boolean) => void }) {
  const [on, setOn] = useState(false);
  const { request, dialog } = useAutoMergeConfirm((next, confirmed) => {
    setOn(next);
    onChange(next, confirmed);
  });
  return (
    <>
      <label>
        <input type="checkbox" checked={on} onChange={(e) => request(e.target.checked)} />
        Merge automatically
      </label>
      {dialog}
    </>
  );
}

const box = () => screen.getByRole("checkbox", { name: "Merge automatically" });

describe("useAutoMergeConfirm without the confirmation (the default)", () => {
  it("ticking turns it on at once, unticking off", () => {
    confirmation(false);
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(box());
    expect(screen.queryByText("Merge automatically?")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(true, true);
    expect((box() as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box());
    expect(onChange).toHaveBeenLastCalledWith(false, false);
  });
});

describe("useAutoMergeConfirm with the confirmation on", () => {
  beforeEach(() => confirmation(true));

  it("ticking opens the dialog and leaves the box unticked until accepted", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(box());
    expect(screen.getByText("Merge automatically?")).toBeTruthy();
    expect(
      screen.getByText(
        "Optio will merge the MR by itself when CI passes and no reviewer requested changes.",
      ),
    ).toBeTruthy();
    expect((box() as HTMLInputElement).checked).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("cancel leaves it unchecked", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(box());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Merge automatically?")).toBeNull();
    expect((box() as HTMLInputElement).checked).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("only 'Yes, merge automatically' turns it on, confirmed", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(box());
    fireEvent.click(screen.getByRole("button", { name: "Yes, merge automatically" }));
    expect(onChange).toHaveBeenCalledWith(true, true);
    expect((box() as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText("Merge automatically?")).toBeNull();
  });

  it("unticking turns it off without asking", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(box());
    fireEvent.click(screen.getByRole("button", { name: "Yes, merge automatically" }));
    fireEvent.click(box());
    expect(onChange).toHaveBeenLastCalledWith(false, false);
    expect(screen.queryByText("Merge automatically?")).toBeNull();
  });
});

describe("AutoMergeConfirmedNote", () => {
  it("says nothing without the confirmation (the default)", () => {
    confirmation(false);
    const { container } = render(<AutoMergeConfirmedNote at="2026-10-01T12:00:00Z" by="Ann Lee" />);
    expect(container.textContent).toBe("");
  });

  it("says when and by whom", () => {
    confirmation(true);
    render(<AutoMergeConfirmedNote at="2026-10-01T12:00:00Z" by="Ann Lee" />);
    expect(screen.getByText(/^Confirmed on .*2026 by Ann Lee$/)).toBeTruthy();
  });

  it("says nothing when it was never confirmed", () => {
    const { container } = render(<AutoMergeConfirmedNote at={null} by="Ann Lee" />);
    expect(container.textContent).toBe("");
  });
});
