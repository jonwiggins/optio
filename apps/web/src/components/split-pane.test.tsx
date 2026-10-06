import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const mockStorage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: vi.fn((key: string) => mockStorage[key] ?? null),
  setItem: vi.fn((key: string, val: string) => {
    mockStorage[key] = val;
  }),
});

vi.mock("lucide-react", () => ({
  PanelLeftClose: (props: any) => <span data-testid="panel-left-close" {...props} />,
  PanelRightClose: (props: any) => <span data-testid="panel-right-close" {...props} />,
}));

import { SplitPane } from "./split-pane";

describe("SplitPane", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockStorage)) {
      delete mockStorage[key];
    }
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  it("renders both left and right panes with content", () => {
    render(<SplitPane left={<div>Left Content</div>} right={<div>Right Content</div>} />);
    expect(screen.getByText("Left Content")).toBeInTheDocument();
    expect(screen.getByText("Right Content")).toBeInTheDocument();
  });

  it("renders custom labels", () => {
    render(
      <SplitPane
        left={<div>L</div>}
        right={<div>R</div>}
        leftLabel="Editor"
        rightLabel="Preview"
      />,
    );
    expect(screen.getByText("Editor")).toBeInTheDocument();
    expect(screen.getByText("Preview")).toBeInTheDocument();
  });

  it("uses default 45% left width when no saved state", () => {
    const { container } = render(<SplitPane left={<div>L</div>} right={<div>R</div>} />);
    const panes = container.querySelectorAll("[style]");
    const leftPane = Array.from(panes).find((el) => (el as HTMLElement).style.width === "45%");
    expect(leftPane).toBeTruthy();
  });

  it("loads saved position from localStorage", () => {
    mockStorage["optio-split-pane"] = JSON.stringify({ leftPct: 60 });
    const { container } = render(<SplitPane left={<div>L</div>} right={<div>R</div>} />);
    const panes = container.querySelectorAll("[style]");
    const leftPane = Array.from(panes).find((el) => (el as HTMLElement).style.width === "60%");
    expect(leftPane).toBeTruthy();
  });

  it("collapses left pane on toggle button click (left pane width becomes 0)", () => {
    const { container } = render(<SplitPane left={<div>L</div>} right={<div>R</div>} />);
    // Click the button that hides the left (Chat) pane
    fireEvent.click(screen.getByTitle("Hide Chat"));

    // After collapsing, the left pane gets the w-0 class
    expect(container.querySelector(".w-0")).not.toBeNull();
  });

  it("collapses right pane on toggle button click", () => {
    const { container } = render(<SplitPane left={<div>L</div>} right={<div>R</div>} />);
    fireEvent.click(screen.getByTitle("Hide Terminal"));

    expect(container.querySelector(".w-0")).not.toBeNull();
  });

  it("shows expand button when a pane is collapsed", () => {
    render(<SplitPane left={<div>L</div>} right={<div>R</div>} />);
    // Collapse the left pane
    fireEvent.click(screen.getByTitle("Hide Chat"));

    // Expand buttons with title "Show Chat" should appear
    const showButtons = screen.getAllByTitle("Show Chat");
    expect(showButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("persists layout to localStorage on render", () => {
    render(<SplitPane left={<div>L</div>} right={<div>R</div>} />);
    expect(localStorage.setItem).toHaveBeenCalledWith(
      "optio-split-pane",
      JSON.stringify({ leftPct: 45 }),
    );
  });
  it("clamps a stale saved size and supports keyboard resizing", () => {
    mockStorage["optio-split-pane"] = JSON.stringify({ leftPct: 120 });
    render(<SplitPane left={<div>L</div>} right={<div>R</div>} />);
    const handle = screen.getByRole("separator");
    expect(handle).toHaveAttribute("aria-valuenow", "85");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle).toHaveAttribute("aria-valuenow", "83");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", "15");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle).toHaveAttribute("aria-valuenow", "15");
  });

  it("reveals a hidden terminal when another shell opens", () => {
    const { rerender } = render(<SplitPane left={<div>L</div>} right={<div>R</div>} />);
    fireEvent.click(screen.getByTitle("Hide Terminal"));
    rerender(<SplitPane left={<div>L</div>} right={<div>R</div>} revealRightKey="1" />);
    expect(screen.getByRole("region", { name: "Terminal" })).not.toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});
