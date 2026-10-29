import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WorkLinkBadge } from "./work-links";

const pr = {
  url: "https://github.com/acme/app/pull/607",
  kind: "pr" as const,
  provider: "github" as const,
  label: "acme/app#607",
};
const ticket = {
  url: "https://linear.app/acme/issue/ENG-12",
  kind: "issue" as const,
  provider: "linear" as const,
  label: "ENG-12",
};

describe("WorkLinkBadge", () => {
  afterEach(cleanup);

  it("reads as an open PR with nothing extra before the host answers", () => {
    render(<WorkLinkBadge link={pr} />);
    const badge = screen.getByRole("link");
    expect(badge.getAttribute("title")).toBe("Pull request · https://github.com/acme/app/pull/607");
    expect(badge.getAttribute("data-state")).toBeNull();
    expect(badge.querySelector("[data-mark]")).toBeNull();
  });

  it("wears a merged PR's purple and says so", () => {
    render(<WorkLinkBadge link={pr} status={{ url: pr.url, state: "merged" }} />);
    const badge = screen.getByRole("link");
    expect(badge.getAttribute("title")).toContain("· merged ·");
    expect(badge.className).toContain("border-[#8957e5]");
    expect(badge.querySelector("svg")!.getAttribute("class")).toContain("text-[#8957e5]");
    expect(badge.querySelector("[data-mark]")).toBeNull();
  });

  it("marks an open PR's CI and review in one dot or check", () => {
    const { rerender } = render(
      <WorkLinkBadge link={pr} status={{ url: pr.url, state: "open", checks: "pending" }} />,
    );
    expect(screen.getByRole("link").querySelector("[data-mark]")!.getAttribute("data-mark")).toBe(
      "bg-warning",
    );
    rerender(
      <WorkLinkBadge
        link={pr}
        status={{ url: pr.url, state: "open", checks: "passing", review: "changes_requested" }}
      />,
    );
    expect(screen.getByRole("link").querySelector("[data-mark]")!.getAttribute("data-mark")).toBe(
      "bg-error",
    );
    rerender(
      <WorkLinkBadge
        link={pr}
        status={{ url: pr.url, state: "open", checks: "passing", review: "approved" }}
      />,
    );
    const badge = screen.getByRole("link");
    expect(badge.querySelector("[data-mark]")).toBeNull();
    expect(badge.querySelectorAll("svg")).toHaveLength(3); // glyph, check, external-link
    expect(badge.getAttribute("title")).toContain("open · CI passing · approved");
  });

  it("keeps a draft grey", () => {
    render(<WorkLinkBadge link={pr} status={{ url: pr.url, state: "draft", checks: "none" }} />);
    const badge = screen.getByRole("link");
    expect(badge.className).toContain("border-border/70");
    expect(badge.querySelector("svg")!.getAttribute("class")).toContain("text-text-muted");
  });

  it("reads a bare ref as the PR it turned out to be", () => {
    const ref = {
      url: "https://github.com/acme/app/issues/27",
      kind: "ref" as const,
      provider: "github" as const,
      label: "#27",
    };
    render(<WorkLinkBadge link={ref} status={{ url: ref.url, state: "closed" }} />);
    const badge = screen.getByRole("link");
    expect(badge.getAttribute("title")).toBe(
      "Pull request · closed · https://github.com/acme/app/issues/27",
    );
    expect(badge.querySelector("svg")!.getAttribute("class")).toContain("text-error");
  });

  it("closes a done GitHub issue's glyph without a second check", () => {
    const issue = {
      url: "https://github.com/acme/app/issues/3",
      kind: "issue" as const,
      provider: "github" as const,
      label: "acme/app#3",
    };
    render(<WorkLinkBadge link={issue} status={{ url: issue.url, state: "done" }} />);
    const badge = screen.getByRole("link");
    expect(badge.getAttribute("title")).toContain("Issue · done ·");
    expect(badge.querySelectorAll("svg")).toHaveLength(2); // glyph, external-link
    expect(badge.querySelector("svg")!.getAttribute("class")).toContain("text-[#8957e5]");
  });

  it("shows a ticket's progress quietly: a dot in progress, a check when done", () => {
    const { rerender } = render(
      <WorkLinkBadge link={ticket} status={{ url: ticket.url, state: "in_progress" }} />,
    );
    expect(screen.getByRole("link").querySelector("[data-mark]")!.getAttribute("data-mark")).toBe(
      "bg-warning",
    );
    rerender(<WorkLinkBadge link={ticket} status={{ url: ticket.url, state: "done" }} />);
    const badge = screen.getByRole("link");
    expect(badge.querySelector("[data-mark]")).toBeNull();
    expect(badge.getAttribute("title")).toContain("Linear ticket · done ·");
    expect(badge.className).toContain("border-[#8957e5]");
  });
});
