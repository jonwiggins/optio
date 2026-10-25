import { describe, expect, it } from "vitest";
import {
  coAuthor,
  commitTrailerEnv,
  commitTrailers,
  isJiraKey,
  jiraKeyOf,
  mrFooter,
  mrTitle,
  oneLine,
  shellDoubleQuoted,
  traceabilityPromptVars,
} from "./work-traceability.js";

const jira = {
  title: "Add a /health endpoint",
  ticketSource: "jira",
  ticketKey: "PLAT-1",
  ticketUrl: "https://jira.example.test/browse/PLAT-1",
  requester: { name: "Ada Lovelace", email: "ada@example.test" },
  teamName: "Platform",
  runUrl: "https://optio.example.test/work/abc",
};

describe("the MR title", () => {
  it("starts with the Jira key for work from a Jira ticket", () => {
    expect(mrTitle(jira)).toBe("PLAT-1: Add a /health endpoint");
  });

  it("is not prefixed twice, but PLAT-12 is not PLAT-1", () => {
    expect(mrTitle({ ...jira, title: "PLAT-1: already there" })).toBe("PLAT-1: already there");
    expect(mrTitle({ ...jira, title: "plat-1 lower case" })).toBe("plat-1 lower case");
    expect(mrTitle({ ...jira, title: "PLAT-12 is another" })).toBe("PLAT-1: PLAT-12 is another");
  });

  it("is the title alone for other work, and for a GitLab issue number", () => {
    expect(mrTitle({ title: "Fix it" })).toBe("Fix it");
    expect(mrTitle({ title: "Fix it", ticketSource: "gitlab", ticketKey: "12" })).toBe("Fix it");
    // Not a key: a Jira source with an odd id is left alone.
    expect(mrTitle({ title: "Fix it", ticketSource: "jira", ticketKey: "10023" })).toBe("Fix it");
  });

  it("is one line", () => {
    expect(mrTitle({ ...jira, title: "two\nlines\t here" })).toBe("PLAT-1: two lines here");
  });
});

describe("Jira keys", () => {
  it("knows a key", () => {
    expect(isJiraKey("PLAT-1")).toBe(true);
    expect(isJiraKey("AB_2-99")).toBe(true);
    expect(isJiraKey("plat-1")).toBe(false);
    expect(isJiraKey("1-1")).toBe(false);
    expect(isJiraKey("PLAT-1; rm -rf /")).toBe(false);
    expect(isJiraKey(null)).toBe(false);
  });

  it("is only Jira's", () => {
    expect(jiraKeyOf(jira)).toBe("PLAT-1");
    expect(jiraKeyOf({ ticketSource: "linear", ticketKey: "ENG-1" })).toBeNull();
  });
});

describe("commit trailers", () => {
  it("name the ticket, the requester, the run and the team, in that order", () => {
    expect(commitTrailers(jira)).toEqual([
      ["Jira", "PLAT-1"],
      ["Co-authored-by", "Ada Lovelace <ada@example.test>"],
      ["Optio-Run", "https://optio.example.test/work/abc"],
      ["Optio-Team", "Platform"],
    ]);
  });

  it("leave out what isn't known: no email, no co-author; no team, no team trailer", () => {
    expect(
      commitTrailers({
        title: "x",
        requester: { name: "Bob" },
        runUrl: "https://o/work/1",
      }),
    ).toEqual([["Optio-Run", "https://o/work/1"]]);
    expect(commitTrailers({ title: "x" })).toEqual([]);
  });

  it("never carry a newline or angle brackets into a trailer", () => {
    expect(coAuthor({ name: "Eve <evil>\nSigned-off-by: x", email: "eve@example.test" })).toBe(
      "Eve evil Signed-off-by: x <eve@example.test>",
    );
    expect(coAuthor({ name: "Eve", email: "eve@example.test>\nX: y" })).toBeNull();
    expect(coAuthor({ name: "", email: "eve@example.test" })).toBe(
      "eve@example.test <eve@example.test>",
    );
  });

  it("travel to the hook as environment variables", () => {
    expect(commitTrailerEnv(jira)).toEqual({
      OPTIO_JIRA_KEY: "PLAT-1",
      OPTIO_COMMIT_CO_AUTHOR: "Ada Lovelace <ada@example.test>",
      OPTIO_RUN_URL: "https://optio.example.test/work/abc",
      OPTIO_TEAM_NAME: "Platform",
    });
    expect(commitTrailerEnv({ title: "x" })).toEqual({});
  });
});

describe("the MR footer", () => {
  it("links the ticket and names the requester, the team and the run", () => {
    expect(mrFooter(jira)).toBe(
      [
        "---",
        "Jira: [PLAT-1](https://jira.example.test/browse/PLAT-1)  ",
        "Requested by: Ada Lovelace  ",
        "Team: Platform  ",
        "Optio run: https://optio.example.test/work/abc",
      ].join("\n"),
    );
  });

  it("is empty with nothing to say", () => {
    expect(mrFooter({ title: "x" })).toBe("");
  });
});

describe("the prompt variables", () => {
  it("escape the title for a double-quoted shell string", () => {
    const vars = traceabilityPromptVars({ ...jira, title: 'say "hi" $(id) `x` \\' });
    expect(vars.MR_TITLE).toBe('PLAT-1: say \\"hi\\" \\$(id) \\`x\\` \\\\');
    expect(vars.JIRA_KEY).toBe("PLAT-1");
    expect(vars.COMMIT_TRAILERS.split("\n")).toHaveLength(4);
  });

  it("are empty strings for work with nothing to trace", () => {
    const vars = traceabilityPromptVars({ title: "Plain" });
    expect(vars).toEqual({ MR_TITLE: "Plain", MR_FOOTER: "", JIRA_KEY: "", COMMIT_TRAILERS: "" });
  });

  it("helpers", () => {
    expect(shellDoubleQuoted("a$b")).toBe("a\\$b");
    expect(oneLine("  a\u0000b\r\nc  ")).toBe("a b c");
  });
});
