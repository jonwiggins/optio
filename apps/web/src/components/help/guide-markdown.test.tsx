import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { USING_OPTIO_GUIDE } from "@/content/using-optio-guide";
import { GuideMarkdown, guideLink, slugify } from "./guide-markdown";

afterEach(() => cleanup());

describe("slugify (GitLab's heading anchors)", () => {
  it("lower case, punctuation dropped, spaces to hyphens", () => {
    expect(slugify("Sign in")).toBe("sign-in");
    expect(slugify("With @optio in a GitLab comment")).toBe("with-optio-in-a-gitlab-comment");
    expect(slugify("Team or personal work")).toBe("team-or-personal-work");
  });
});

describe("guideLink", () => {
  it("keeps anchors and web links; another doc stays text, named in the source", () => {
    expect(guideLink("#sign-in")).toEqual({ kind: "anchor", href: "#sign-in" });
    expect(guideLink("https://optio.example.com")).toEqual({
      kind: "external",
      href: "https://optio.example.com",
    });
    expect(guideLink("deploy/operations.md")).toEqual({
      kind: "doc",
      file: "docs/deploy/operations.md",
    });
    expect(guideLink("model-gateway.md#keys-optio-makes")).toEqual({
      kind: "doc",
      file: "docs/model-gateway.md",
    });
    expect(guideLink("/settings")).toBeNull();
  });
});

describe("GuideMarkdown", () => {
  it("renders the guide with an id on every heading its contents link to", () => {
    const { container } = render(<GuideMarkdown source={USING_OPTIO_GUIDE} />);
    expect(screen.getByRole("heading", { level: 1, name: "Using Optio" })).toBeInTheDocument();
    const anchors = [...USING_OPTIO_GUIDE.matchAll(/\]\(#([a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(10);
    for (const id of new Set(anchors)) {
      expect(container.querySelector(`[id="${id}"]`), `#${id}`).not.toBeNull();
    }
  });

  it("a link to another doc is text (that doc isn't served in the app)", () => {
    render(<GuideMarkdown source="See the [runbook](deploy/operations.md)." />);
    expect(screen.queryByRole("link", { name: "runbook" })).not.toBeInTheDocument();
    expect(screen.getByText("runbook")).toHaveAttribute(
      "title",
      "docs/deploy/operations.md in the Optio source",
    );
  });

  it("renders the tables", () => {
    render(<GuideMarkdown source={USING_OPTIO_GUIDE} />);
    expect(screen.getAllByRole("table").length).toBeGreaterThan(3);
  });
});
