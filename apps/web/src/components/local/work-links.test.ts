import { describe, expect, it } from "vitest";
import { collectWorkLinks } from "./work-links";

const pr = {
  url: "https://github.com/acme/app/pull/607",
  kind: "pr" as const,
  provider: "github" as const,
  label: "acme/app#607",
};

describe("collectWorkLinks", () => {
  it("shows the PR a review-request session was started for once, as a PR", () => {
    const links = collectWorkLinks({
      links: [pr],
      ticketUrl: "https://github.com/Acme/App/pull/607",
      ticketSource: "github",
      ticketExternalId: "607",
    });
    expect(links).toEqual([pr]);
  });

  it("puts the spawning ticket first when the output never named it", () => {
    const links = collectWorkLinks({
      links: [pr],
      ticketUrl: "https://github.com/acme/app/issues/12",
      ticketSource: "github",
      ticketExternalId: "12",
    });
    expect(links.map((l) => [l.kind, l.label])).toEqual([
      ["issue", "#12"],
      ["pr", "acme/app#607"],
    ]);
  });

  it("dedupes links stored before the daemon did", () => {
    const ref = {
      ...pr,
      url: "https://github.com/acme/app/issues/607",
      kind: "ref" as const,
      label: "#607",
    };
    expect(collectWorkLinks({ links: [ref, pr] })).toEqual([pr]);
  });
});
