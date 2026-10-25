import { describe, expect, it } from "vitest";
import {
  isGitLabUsername,
  mentionsAnyone,
  mentionsUser,
  ownWords,
  parseMentionCommand,
  titleLine,
} from "./commands.js";

const BOT = "optio-bot";

describe("mentionsUser", () => {
  it("finds the bot anywhere in the comment's own words, in any case", () => {
    expect(mentionsUser("@optio-bot add a line to README", BOT)).toBe(true);
    expect(mentionsUser("Hey @Optio-Bot, can you look?", BOT)).toBe(true);
    expect(mentionsUser("thanks\n\n@optio-bot fix ci", BOT)).toBe(true);
    expect(mentionsUser("(@optio-bot) please", BOT)).toBe(true);
    expect(mentionsUser("done @optio-bot.", BOT)).toBe(true);
  });

  it("doesn't take a longer name, an address or a path for the bot", () => {
    expect(mentionsUser("@optio-bot2 add it", BOT)).toBe(false);
    expect(mentionsUser("@optio-bot-staging add it", BOT)).toBe(false);
    expect(mentionsUser("@optio-bot.staging add it", BOT)).toBe(false);
    expect(mentionsUser("mail optio@optio-bot.example.test", BOT)).toBe(false);
    expect(mentionsUser("see https://gitlab.example.test/@optio-bot", BOT)).toBe(false);
    expect(mentionsUser("@alice add it", BOT)).toBe(false);
  });

  it("ignores code and quoted lines", () => {
    expect(mentionsUser("Use `@optio-bot fix ci` to retry", BOT)).toBe(false);
    expect(mentionsUser("```\n@optio-bot add a line\n```\nlike that", BOT)).toBe(false);
    expect(mentionsUser("~~~text\n@optio-bot x\n~~~", BOT)).toBe(false);
    expect(mentionsUser("> @optio-bot add a line\n\nI agree", BOT)).toBe(false);
    expect(mentionsUser("> @optio-bot add a line\n\n@optio-bot do it", BOT)).toBe(true);
  });

  it("refuses a username that isn't one", () => {
    expect(mentionsUser("@optio-bot x", "")).toBe(false);
    expect(mentionsUser("@a b", "a b")).toBe(false);
  });
});

describe("mentionsAnyone", () => {
  it("is the ingress's cheap test", () => {
    expect(mentionsAnyone("ping @bob")).toBe(true);
    expect(mentionsAnyone("no one here")).toBe(false);
    expect(mentionsAnyone("mail a@b.c")).toBe(false);
    expect(mentionsAnyone("`@bob`")).toBe(false);
  });
});

describe("ownWords", () => {
  it("blanks an unclosed fence to the end", () => {
    expect(ownWords("before\n```\n@x\nmore")).toBe("before\n");
  });
});

describe("parseMentionCommand", () => {
  it("takes the rest of the comment as the instruction", () => {
    expect(parseMentionCommand("@optio-bot add a line to README", BOT)).toEqual({
      kind: "work",
      instruction: "add a line to README",
      team: null,
    });
    expect(parseMentionCommand("Hey @optio-bot, please rename foo to bar.", BOT)).toEqual({
      kind: "work",
      instruction: "Hey, please rename foo to bar.",
      team: null,
    });
    expect(parseMentionCommand("@optio-bot: rename foo\n\nand bar", BOT).instruction).toBe(
      "rename foo\n\nand bar",
    );
  });

  it("keeps code in the instruction", () => {
    const c = parseMentionCommand("@optio-bot change it to\n```js\nconst a = 1;\n```", BOT);
    expect(c.kind).toBe("work");
    expect(c.instruction).toContain("const a = 1;");
  });

  it('reads team:<slug> and team:"Name" and drops them from the instruction', () => {
    expect(parseMentionCommand("@optio-bot team:platform bump the image", BOT)).toEqual({
      kind: "work",
      instruction: "bump the image",
      team: "platform",
    });
    expect(parseMentionCommand('@optio-bot bump it team:"Platform Team"', BOT)).toEqual({
      kind: "work",
      instruction: "bump it",
      team: "Platform Team",
    });
    expect(parseMentionCommand("@optio-bot fix ci team:platform", BOT)).toEqual({
      kind: "fix_pipeline",
      instruction: "",
      team: "platform",
    });
  });

  it("knows fix pipeline, fix ci and fix the build", () => {
    for (const text of [
      "@optio-bot fix pipeline",
      "@optio-bot fix the pipeline",
      "@optio-bot Fix CI",
      "@optio-bot please fix the build!",
      "@optio-bot can you fix this pipeline?",
    ]) {
      expect(parseMentionCommand(text, BOT).kind, text).toBe("fix_pipeline");
    }
    expect(parseMentionCommand("@optio-bot fix pipeline: the lint job only", BOT)).toEqual({
      kind: "fix_pipeline",
      instruction: "the lint job only",
      team: null,
    });
    expect(parseMentionCommand("@optio-bot fix the pipelines docs page", BOT).kind).toBe("work");
    expect(parseMentionCommand("@optio-bot fix circular import", BOT).kind).toBe("work");
  });

  it("takes fix pipeline with a separator and more words", () => {
    for (const [text, instruction] of [
      ["@optio-bot fix ci!", ""],
      ["@optio-bot fix pipeline please", ""],
      ["@optio-bot fix pipeline, only the unit job", "only the unit job"],
      ["@optio-bot fix pipeline - only lint", "only lint"],
      ["@optio-bot fix the build.\nThe lint job is flaky.", "The lint job is flaky."],
      ["@optio-bot fix pipeline\n\nonly the lint job", "only the lint job"],
    ] as const) {
      expect(parseMentionCommand(text, BOT), text).toEqual({
        kind: "fix_pipeline",
        instruction,
        team: null,
      });
    }
  });

  it("leaves a request about the build or CI files as work, whole", () => {
    for (const instruction of [
      "fix the build script so it works on Windows",
      "fix ci config to use node 22",
      "fix build.gradle dependency versions",
      "fix the pipeline.yml include",
      "Fix CI-only env vars",
      "fix the build please do it on main",
    ]) {
      expect(parseMentionCommand(`@optio-bot ${instruction}`, BOT), instruction).toEqual({
        kind: "work",
        instruction,
        team: null,
      });
    }
  });

  it("answers help, and an empty mention is empty", () => {
    expect(parseMentionCommand("@optio-bot help", BOT).kind).toBe("help");
    expect(parseMentionCommand("@optio-bot what can you do?", BOT).kind).toBe("help");
    expect(parseMentionCommand("@optio-bot", BOT)).toEqual({
      kind: "empty",
      instruction: "",
      team: null,
    });
    expect(parseMentionCommand("@optio-bot team:platform", BOT)).toEqual({
      kind: "empty",
      instruction: "",
      team: "platform",
    });
  });

  it("cuts a very long comment", () => {
    const c = parseMentionCommand(`@optio-bot ${"x".repeat(30_000)}`, BOT);
    expect(c.instruction.length).toBeLessThanOrEqual(20_000);
  });
});

describe("helpers", () => {
  it("isGitLabUsername", () => {
    expect(isGitLabUsername("optio-bot")).toBe(true);
    expect(isGitLabUsername("a.b_c")).toBe(true);
    expect(isGitLabUsername("")).toBe(false);
    expect(isGitLabUsername("a b")).toBe(false);
    expect(isGitLabUsername(null)).toBe(false);
  });

  it("titleLine takes the first non-empty line, cut", () => {
    expect(titleLine("\n  add   a line \nmore")).toBe("add a line");
    expect(titleLine("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
