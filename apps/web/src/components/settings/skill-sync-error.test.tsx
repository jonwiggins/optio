import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SkillSyncError } from "./skill-sync-error";
afterEach(cleanup);
describe("marketplace sync error", () => {
  it("shows the summary and expandable diagnostics", () => {
    render(
      <SkillSyncError
        error={
          "Could not resolve the source ref. Git authentication failed.\nfatal: terminal prompts disabled"
        }
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Git authentication failed");
    const summary = screen.getByText("Sync error details");
    fireEvent.click(summary);
    expect(summary.closest("details")).toHaveAttribute("open");
    expect(screen.getByText("fatal: terminal prompts disabled")).toBeVisible();
  });
  it("supports older saved errors and clears after success", () => {
    const { rerender } = render(
      <SkillSyncError error={"Command failed: git ls-remote\nfatal: terminal prompts disabled"} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Skill sync failed");
    rerender(<SkillSyncError error={null} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
