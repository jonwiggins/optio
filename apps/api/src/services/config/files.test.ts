import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readManifestDirectory } from "./files.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "optio-config-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(rel: string, text: string) {
  const file = path.join(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

describe("readManifestDirectory", () => {
  it("reads every yaml file recursively, every document in each, inlining file fields", async () => {
    await write(
      "work/nightly.yaml",
      [
        "apiVersion: optio/v1",
        "kind: Work",
        "metadata: { name: nightly }",
        "spec:",
        "  who: { runtime: claude-code }",
        "  what: { promptFile: ./nightly.md }",
      ].join("\n"),
    );
    await write("work/nightly.md", "Bump things\n");
    await write(
      "prompts.yml",
      [
        "apiVersion: optio/v1",
        "kind: Prompt",
        "metadata: { name: one }",
        "spec: { template: one }",
        "---",
        "apiVersion: optio/v1",
        "kind: Prompt",
        "metadata: { name: two }",
        "spec: { template: two }",
      ].join("\n"),
    );
    await write(".hidden/skip.yaml", "kind: Nope");
    await write("notes.txt", "not yaml");

    const read = await readManifestDirectory(dir);
    expect(read.errors).toEqual([]);
    expect(read.files).toBe(2);
    expect(read.manifests.map((m) => m.path)).toEqual([
      "prompts.yml#1",
      "prompts.yml#2",
      "work/nightly.yaml",
    ]);
    const work = read.manifests[2].document as {
      spec: { what: { prompt: string; promptFile?: string } };
    };
    expect(work.spec.what).toEqual({ prompt: "Bump things\n" });
    expect(read.hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("reports a file that doesn't parse and a missing included file, and reads the rest", async () => {
    await write("bad.yaml", "kind: [unterminated");
    await write(
      "missing.yaml",
      "kind: Prompt\nmetadata: { name: m }\nspec: { templateFile: nope.md }",
    );
    await write("ok.yaml", "kind: Prompt\nmetadata: { name: ok }\nspec: { template: fine }");
    const read = await readManifestDirectory(dir);
    expect(read.manifests.map((m) => m.path)).toEqual(["ok.yaml"]);
    expect(read.errors.map((e) => [e.path, e.action])).toEqual([
      ["bad.yaml", "error"],
      ["missing.yaml", "error"],
    ]);
    expect(read.errors[1].name).toBe("m");
    expect(read.errors[1].message).toMatch(/nope\.md/);
  });

  it("refuses an included file outside the directory", async () => {
    await write(
      "escape.yaml",
      "kind: Prompt\nmetadata: { name: e }\nspec: { templateFile: ../../etc/passwd }",
    );
    const read = await readManifestDirectory(dir);
    expect(read.manifests).toEqual([]);
    expect(read.errors[0].message).toMatch(/outside the configuration directory/);
  });

  it("changes its hash when a file changes", async () => {
    await write("a.yaml", "kind: Prompt\nmetadata: { name: a }\nspec: { template: one }");
    const first = (await readManifestDirectory(dir)).hash;
    await write("a.yaml", "kind: Prompt\nmetadata: { name: a }\nspec: { template: two }");
    expect((await readManifestDirectory(dir)).hash).not.toBe(first);
  });

  it("throws when the directory doesn't exist", async () => {
    await expect(readManifestDirectory(path.join(dir, "nope"))).rejects.toThrow();
  });
});
