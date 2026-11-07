import { describe, expect, it } from "vitest";
import { ROUND_TRIP_SOURCES, ROUND_TRIP_SUPPORT } from "@optio/shared";
import { getTicketRoundTrip } from "./index.js";
import { notionRichText } from "./notion-round-trip.js";
import {
  atMentions,
  linkCommentBody,
  markdownCommentBody,
  parseTicketTime,
  sameTicketAccount,
} from "./round-trip.js";

describe("the round trip's implementations", () => {
  it("one per source the settings offer, saying the same about links and statuses", () => {
    for (const source of ROUND_TRIP_SOURCES) {
      const rt = getTicketRoundTrip(source);
      expect(rt?.source).toBe(source);
      expect(rt!.capabilities.links).toBe(ROUND_TRIP_SUPPORT[source].link !== null);
      expect(rt!.capabilities.statuses).toBe(ROUND_TRIP_SUPPORT[source].statuses);
    }
    expect(getTicketRoundTrip("trello")).toBeNull();
    expect(getTicketRoundTrip(undefined)).toBeNull();
  });

  it("take a ticket id the way each service's tickets are keyed", () => {
    const id = (source: string, input: string) =>
      getTicketRoundTrip(source)!.normalizeTicketId(input);
    expect(id("jira", " plat-1 ")).toBe("PLAT-1");
    expect(id("jira", "12")).toBeNull();
    expect(id("github", "#12")).toBe("12");
    expect(id("github", "https://github.com/acme/app/issues/12")).toBe("12");
    expect(id("github", "PLAT-1")).toBeNull();
    expect(id("gitlab", "12")).toBe("12");
    expect(id("gitlab", "https://gitlab.example.com/g/p/-/issues/7")).toBe("7");
    expect(id("linear", "eng-123")).toBe("ENG-123");
    expect(id("linear", "https://linear.app/acme/issue/ENG-9/add-health")).toBe("ENG-9");
    expect(
      id("notion", "https://www.notion.so/acme/Add-health-1a2b3c4d5e6f40718293a4b5c6d7e8f9"),
    ).toBe("1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9");
    expect(id("notion", "not a page")).toBeNull();
  });

  it("know a mention of their own account, in each service's syntax", () => {
    const me = { accountId: "1", name: "optio-bot", key: "JIRAUSER1", displayName: "Optio Bot" };
    const says = (source: string, body: string) =>
      getTicketRoundTrip(source)!.mentionsAccount(body, me);
    expect(says("jira", "[~optio-bot] add a test")).toBe(true);
    expect(says("jira", "@optio-bot add a test")).toBe(false);
    expect(says("github", "@optio-bot add a test")).toBe(true);
    expect(says("github", "mail optio-bot@example.com")).toBe(false);
    expect(says("github", "@optio-bot-two do it")).toBe(false);
    expect(says("gitlab", "please @Optio-Bot")).toBe(true);
    expect(says("linear", "@optio-bot do it")).toBe(true);
    expect(says("notion", "@Optio Bot do it")).toBe(true);
    expect(says("notion", "Optio Bot did it")).toBe(false);
  });
});

describe("comment bodies", () => {
  it("Markdown: text escaped, links as [text](url)", () => {
    expect(
      markdownCommentBody([
        "Optio opened ",
        { text: "pull request #7", href: "https://github.com/a/b/pull/7" },
        " for *this* [ticket].",
      ]),
    ).toBe(
      "Optio opened [pull request #7](https://github.com/a/b/pull/7) for \\*this\\* \\[ticket\\].",
    );
    expect(markdownCommentBody([{ text: "x", href: "https://e.example/a (b)" }])).toBe(
      "[x](https://e.example/a%20%28b%29)",
    );
  });

  it("the link comment: a title linking the work, its state, and the work's id hidden", () => {
    const body = linkCommentBody({
      globalId: "optio:t-1",
      url: "https://optio.example.com/work/t-1",
      title: "Optio: Add a /health endpoint",
      summary: "In progress",
    });
    expect(body).toBe(
      "**Optio**: [Optio: Add a /health endpoint](https://optio.example.com/work/t-1)\n\nIn progress\n\n<!-- optio:t-1 -->",
    );
  });

  it("Notion: rich text items of at most 2000 characters, links kept", () => {
    const items = notionRichText([
      "a".repeat(2500),
      { text: "the run", href: "https://r.example" },
    ]);
    expect(items.map((i) => i.text.content.length)).toEqual([2000, 500, 7]);
    expect(items[2].text.link).toEqual({ url: "https://r.example" });
    expect(items[0].text.link).toBeNull();
  });
});

describe("accounts and times", () => {
  it("the same account: the stable id, else the key, else the name", () => {
    expect(sameTicketAccount({ accountId: "1", name: "a" }, { accountId: "1", name: "b" })).toBe(
      true,
    );
    expect(sameTicketAccount({ accountId: "1" }, { accountId: "2" })).toBe(false);
    expect(sameTicketAccount({ name: "Ada" }, { name: "ada" })).toBe(true);
    expect(sameTicketAccount({ name: "ada" }, null)).toBe(false);
  });

  it("times: ISO 8601 and Jira's +0000", () => {
    expect(parseTicketTime("2026-10-24T10:00:00.000+0000")).toBe(
      Date.parse("2026-10-24T10:00:00Z"),
    );
    expect(parseTicketTime("2026-10-24T10:00:00Z")).toBe(Date.parse("2026-10-24T10:00:00Z"));
    expect(parseTicketTime("soon")).toBeNull();
  });

  it("@-mentions: the handle on its own, not inside an address or a longer name", () => {
    expect(atMentions("hey @ada, add a test", "ada")).toBe(true);
    expect(atMentions("ada@example.com", "ada")).toBe(false);
    expect(atMentions("@adam", "ada")).toBe(false);
    expect(atMentions("anything", null)).toBe(false);
  });
});
