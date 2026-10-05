import { describe, expect, it } from "vitest";
import { inlineManifestFiles, uninlinedFileFields, type ManifestFileReader } from "./inline.js";

function reader(
  files: Record<string, string>,
  dirs: Record<string, Record<string, string>> = {},
): ManifestFileReader {
  return {
    async readText(path) {
      if (!(path in files)) throw new Error(`no such file: ${path}`);
      return files[path];
    },
    async readDir(path) {
      if (!(path in dirs)) throw new Error(`no such directory: ${path}`);
      return dirs[path];
    },
  };
}

describe("inlineManifestFiles", () => {
  it("reads a Work prompt and an agent's prompts from files", async () => {
    const doc = {
      kind: "Work",
      spec: {
        what: { promptFile: "./prompt.md" },
        agent: { systemPromptFile: "sys.md", agentsMdFile: "AGENTS.md" },
      },
    };
    const out = (await inlineManifestFiles(
      doc,
      reader({ "./prompt.md": "Do the thing", "sys.md": "You are…", "AGENTS.md": "# Agents" }),
    )) as typeof doc & {
      spec: { what: { prompt: string }; agent: { systemPrompt: string; agentsMd: string } };
    };
    expect(out.spec.what).toEqual({ prompt: "Do the thing" });
    expect(out.spec.agent).toEqual({ systemPrompt: "You are…", agentsMd: "# Agents" });
    // The input is left alone.
    expect(doc.spec.what).toEqual({ promptFile: "./prompt.md" });
  });

  it("reads a Prompt's template and a Skill's prompt", async () => {
    const prompt = await inlineManifestFiles(
      { kind: "Prompt", spec: { templateFile: "t.md" } },
      reader({ "t.md": "Review {{pr}}" }),
    );
    expect((prompt as { spec: { template: string } }).spec).toEqual({ template: "Review {{pr}}" });
    const skill = await inlineManifestFiles(
      { kind: "Skill", spec: { promptFile: "SKILL.md" } },
      reader({ "SKILL.md": "# Skill" }),
    );
    expect((skill as { spec: { prompt: string } }).spec).toEqual({ prompt: "# Skill" });
  });

  it("does not read spec.promptFile for a kind that isn't Skill", async () => {
    const out = await inlineManifestFiles({ kind: "Work", spec: { promptFile: "x" } }, reader({}));
    expect((out as { spec: { promptFile: string } }).spec.promptFile).toBe("x");
  });

  it("turns a Skill's filesFrom directory into its prompt and files", async () => {
    const out = (await inlineManifestFiles(
      { kind: "Skill", spec: { filesFrom: "./release-notes" } },
      reader(
        {},
        { "./release-notes": { "SKILL.md": "# Release notes", "scripts/gen.sh": "echo hi" } },
      ),
    )) as { spec: Record<string, unknown> };
    expect(out.spec).toEqual({
      prompt: "# Release notes",
      files: { "scripts/gen.sh": "echo hi" },
      layout: "skill-dir",
    });
  });

  it("refuses a field given both ways, and a directory with no SKILL.md and no prompt", async () => {
    await expect(
      inlineManifestFiles(
        { kind: "Work", spec: { what: { prompt: "a", promptFile: "b" } } },
        reader({ b: "x" }),
      ),
    ).rejects.toThrow("spec.what.promptFile and spec.what.prompt are both set");
    await expect(
      inlineManifestFiles(
        { kind: "Skill", spec: { filesFrom: "d" } },
        reader({}, { d: { "a.txt": "" } }),
      ),
    ).rejects.toThrow("no SKILL.md");
  });

  it("leaves non-objects alone", async () => {
    expect(await inlineManifestFiles("nope", reader({}))).toBe("nope");
    expect(await inlineManifestFiles(null, reader({}))).toBeNull();
  });
});

describe("uninlinedFileFields", () => {
  it("names the file fields a document still carries", () => {
    expect(
      uninlinedFileFields({
        kind: "Work",
        spec: { what: { promptFile: "p" }, agent: { agentsMdFile: "a" } },
      }),
    ).toEqual(["spec.what.promptFile", "spec.agent.agentsMdFile"]);
    expect(uninlinedFileFields({ kind: "Skill", spec: { filesFrom: "d" } })).toEqual([
      "spec.filesFrom",
    ]);
    expect(uninlinedFileFields({ kind: "Work", spec: { what: { prompt: "p" } } })).toEqual([]);
  });
});
