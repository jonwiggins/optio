import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readManifests } from "../manifests/read.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "optio-cli-manifests-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(rel: string, text: string) {
  const file = path.join(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

describe("readManifests", () => {
  it("reads files and directories, inlines file fields, and reports what doesn't parse", async () => {
    await write(
      "optio/work/a.yaml",
      "kind: Work\nmetadata: { name: a }\nspec:\n  who: { runtime: shell }\n  what: { promptFile: a.sh }\n",
    );
    await write("optio/work/a.sh", "echo hi\n");
    await write("optio/bad.yaml", "kind: [oops");
    await write("single.yaml", "kind: Prompt\nmetadata: { name: p }\nspec: { template: t }\n");

    const read = await readManifests(["optio", "single.yaml"], dir);
    expect(read.manifests.map((m) => m.path)).toEqual(["optio/work/a.yaml", "single.yaml"]);
    const work = read.manifests[0].document as { spec: { what: { prompt: string } } };
    expect(work.spec.what).toEqual({ prompt: "echo hi\n" });
    expect(read.problems).toHaveLength(1);
    expect(read.problems[0].path).toBe("optio/bad.yaml");
  });

  it("numbers the documents of a multi-document file", async () => {
    await write(
      "many.yaml",
      "kind: Prompt\nmetadata: { name: a }\nspec: { template: a }\n---\nkind: Prompt\nmetadata: { name: b }\nspec: { template: b }\n",
    );
    const read = await readManifests(["many.yaml"], dir);
    expect(read.manifests.map((m) => m.path)).toEqual(["many.yaml#1", "many.yaml#2"]);
  });
});
