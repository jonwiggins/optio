import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AutoReviewSwitch, autoReviewPatch, type AutoReviewValue } from "./auto-review-switch";

const off: AutoReviewValue = {
  enabled: false,
  trigger: "on_ci_pass",
  depth: "thorough",
  externalMode: "off",
};

function renderSwitch(value: AutoReviewValue, props: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  render(<AutoReviewSwitch value={value} onChange={onChange} {...props} />);
  return onChange;
}

describe("AutoReviewSwitch", () => {
  afterEach(cleanup);

  it("is one switch while off, with nothing else to choose", () => {
    renderSwitch(off);
    expect(screen.getByText("Turn on automatic code review")).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Automatic code review" }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.queryByRole("button", { name: "After CI passes" })).toBeNull();
  });

  it("turns review on in one click", () => {
    const onChange = renderSwitch(off);
    fireEvent.click(screen.getByRole("switch", { name: "Automatic code review" }));
    expect(onChange).toHaveBeenCalledWith({ ...off, enabled: true });
  });

  it("switching on from manual starts reviews by themselves (the workspace's start)", () => {
    const onChange = renderSwitch({ ...off, trigger: "manual" }, { defaultTrigger: "on_pr" });
    fireEvent.click(screen.getByRole("switch", { name: "Automatic code review" }));
    expect(onChange).toHaveBeenCalledWith({ ...off, enabled: true, trigger: "on_pr" });
  });

  it("offers when it starts, how deep it goes, and other people's PRs / MRs once on", () => {
    const on = { ...off, enabled: true };
    const onChange = renderSwitch(on);
    expect(screen.getByText("Automatic code review is on")).toBeTruthy();

    // Neutral words: a GitHub pull request and a GitLab merge request alike.
    fireEvent.click(screen.getByRole("button", { name: "When the PR / MR opens" }));
    expect(screen.getByText(/Other people.s PRs \/ MRs too/)).toBeTruthy();
    expect(onChange).toHaveBeenLastCalledWith({ ...on, trigger: "on_pr" });

    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...on, depth: "light" });

    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenLastCalledWith({ ...on, externalMode: "on_pr_post" });
  });

  it("shows a held external review as on, and turning it off turns it off", () => {
    const held = { ...off, enabled: true, externalMode: "on_pr_hold" };
    const onChange = renderSwitch(held);
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith({ ...held, externalMode: "off" });
  });

  it("leaves out other people's PRs / MRs where only this work's review is set", () => {
    renderSwitch({ ...off, enabled: true }, { showExternal: false });
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("autoReviewPatch", () => {
  it("maps the value onto the repo's columns", () => {
    expect(
      autoReviewPatch({
        enabled: true,
        trigger: "on_pr",
        depth: "light",
        externalMode: "on_pr_post",
      }),
    ).toEqual({
      reviewEnabled: true,
      reviewTrigger: "on_pr",
      reviewDepth: "light",
      externalReviewMode: "on_pr_post",
    });
    expect(autoReviewPatch({ enabled: false, trigger: "on_ci_pass", depth: "thorough" })).toEqual({
      reviewEnabled: false,
      reviewTrigger: "on_ci_pass",
      reviewDepth: "thorough",
    });
  });
});
