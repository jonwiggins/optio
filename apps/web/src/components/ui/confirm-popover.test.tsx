import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import { ConfirmPopover } from "./confirm-popover";

afterEach(() => {
  cleanup();
});

function Harness({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button>elsewhere</button>
      <ConfirmPopover
        open={open}
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          onConfirm();
        }}
        title="Kill this terminal's process?"
        confirmLabel="Kill"
      >
        <button aria-label="Kill" onClick={() => setOpen(true)}>
          Kill
        </button>
      </ConfirmPopover>
    </div>
  );
}

const trigger = () => screen.getByRole("button", { name: "Kill" });

describe("ConfirmPopover", () => {
  it("opens under the control, focuses the confirm button, and confirms", () => {
    const onConfirm = vi.fn();
    render(
      <Harness
        onConfirm={() => {
          onConfirm();
        }}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Kill this terminal's process?")).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Kill" });
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels on Escape, a click outside, and the cancel button", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    fireEvent.click(trigger());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(trigger());
    fireEvent.pointerDown(screen.getByText("elsewhere"));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(trigger());
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
