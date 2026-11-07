import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RepoPodModePicker, effectiveRepoPodMode } from "./pod-mode-picker";

afterEach(cleanup);

describe("RepoPodModePicker", () => {
  it("names the workspace default and explains shared pods", () => {
    render(<RepoPodModePicker value="inherit" workspacePodMode="shared" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Workspace default (Shared pods)" })).toBeTruthy();
    expect(screen.getByText(/Runs reuse this repo's pods/)).toBeTruthy();
  });

  it("explains a fresh pod per run when picked or inherited", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <RepoPodModePicker value="inherit" workspacePodMode="per_run" onChange={onChange} />,
    );
    expect(
      screen.getByRole("button", { name: "Workspace default (Fresh pod per run)" }),
    ).toBeTruthy();
    expect(screen.getByText(/Each run gets a new pod that is removed when it ends/)).toBeTruthy();

    rerender(<RepoPodModePicker value="shared" workspacePodMode="per_run" onChange={onChange} />);
    expect(screen.getByText(/Runs reuse this repo's pods/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fresh pod per run" }));
    expect(onChange).toHaveBeenCalledWith("per_run");
  });

  it("allows only a fresh pod when the workspace requires it", () => {
    const onChange = vi.fn();
    render(
      <RepoPodModePicker value="shared" workspacePodMode="per_run_required" onChange={onChange} />,
    );
    const shared = screen.getByRole("button", { name: "Shared pods" }) as HTMLButtonElement;
    expect(shared.disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Fresh pod per run" }) as HTMLButtonElement).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(screen.getByText(/Required by the workspace/)).toBeTruthy();
  });
});

describe("effectiveRepoPodMode", () => {
  it("matches the API's resolution", () => {
    expect(effectiveRepoPodMode("inherit", "shared")).toBe("shared");
    expect(effectiveRepoPodMode("inherit", "per_run")).toBe("per_run");
    expect(effectiveRepoPodMode("shared", "per_run")).toBe("shared");
    expect(effectiveRepoPodMode("per_run", "shared")).toBe("per_run");
    expect(effectiveRepoPodMode("shared", "per_run_required")).toBe("per_run");
  });
});
