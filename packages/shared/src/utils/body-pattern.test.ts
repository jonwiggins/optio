import { describe, expect, it } from "vitest";
import { bodyMatches, parseBodyPattern, unsafeRegexReason } from "./body-pattern.js";

describe("bodyMatches", () => {
  it("takes a prefix, case-insensitively, past leading whitespace", () => {
    expect(bodyMatches("/optio retry", "  /Optio retry please")).toBe(true);
    expect(bodyMatches("/optio retry", "please /optio retry")).toBe(false);
    expect(bodyMatches("", "anything")).toBe(true);
    expect(bodyMatches(undefined, null)).toBe(true);
    expect(bodyMatches("/triage", null)).toBe(false);
  });

  it("takes /pattern/flags as a regex matched anywhere, and never a broken one", () => {
    expect(bodyMatches("/\\/optio (retry|rerun)/i", "ok, /OPTIO rerun")).toBe(true);
    expect(bodyMatches("/^LGTM/", "nope LGTM")).toBe(false);
    expect(bodyMatches("/(/", "(")).toBe(false);
    expect(parseBodyPattern("/(/")).toHaveProperty("error");
    expect(parseBodyPattern(" /triage ")).toEqual({ prefix: "/triage" });
  });

  it("reads a slash command with a second slash as the prefix it is, not a regex", () => {
    expect(parseBodyPattern("/deploy/prod")).toEqual({ prefix: "/deploy/prod" });
    expect(bodyMatches("/deploy/prod", "/deploy/prod now")).toBe(true);
    // Only i, m, s and u are flags; g and y would make .test() stateful.
    expect(parseBodyPattern("/x/g")).toEqual({ prefix: "/x/g" });
    expect(parseBodyPattern("/x/i")).toEqual({ regex: /x/i });
  });

  it("refuses regexes that could backtrack catastrophically, and backreferences", () => {
    expect(unsafeRegexReason("^(a+)+$")).toMatch(/nested/);
    expect(unsafeRegexReason("(a|aa)*")).toMatch(/nested/);
    expect(unsafeRegexReason("(\\d+\\s?)*")).toMatch(/nested/);
    expect(unsafeRegexReason("(a){2,}+")).toBeNull(); // `+` after `{2,}` isn't valid JS anyway
    expect(unsafeRegexReason("(a)\\1")).toMatch(/backreference/);
    expect(unsafeRegexReason("(?<x>a)\\k<x>")).toMatch(/backreference/);
    // Ordinary patterns pass: alternation, classes, one level of repetition, lazy quantifiers.
    expect(unsafeRegexReason("^\\/optio (retry|rerun)\\b")).toBeNull();
    expect(unsafeRegexReason("[a-z]+@[a-z.]+")).toBeNull();
    expect(unsafeRegexReason("(abc)+?x*?")).toBeNull();
    expect(unsafeRegexReason("(retry|rerun) now")).toBeNull();
    expect(unsafeRegexReason("^\\/(deploy|rollback) (prod|staging)$")).toBeNull();
    expect(unsafeRegexReason("((a|b)c)+")).toMatch(/nested/);
    expect(unsafeRegexReason("[)+]+")).toBeNull();
    expect(unsafeRegexReason("a{1,3}(bc)?")).toBeNull();
    expect(parseBodyPattern("/^(a+)+$/")).toHaveProperty("error");
    expect(bodyMatches("/^(a+)+$/", "aaaaaaaaaaaaaaaaaaaaaaaaaaaab")).toBe(false);
    // Only the top of a long comment is matched.
    expect(bodyMatches("/zzz$/", `${"a".repeat(2_000)}zzz`)).toBe(false);
    expect(bodyMatches("/^\\/optio/", `/optio ${"a".repeat(2_000)}`)).toBe(true);
  });
});
