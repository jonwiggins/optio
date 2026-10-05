/**
 * `*File` fields of a manifest — `promptFile`, `templateFile`,
 * `systemPromptFile`, `agentsMdFile`, `filesFrom` — name files next to the
 * manifest so long prompts and skill directories don't have to live inside
 * YAML. Whoever reads the directory inlines them before the document is
 * validated: the API for the configuration directory, the CLI for `apply`.
 * Pure: the reader is passed in.
 */

export interface ManifestFileReader {
  /** A file's text, by its path relative to the manifest's directory. */
  readText(relativePath: string): Promise<string>;
  /** Every file under a directory (relative to the manifest), path → text. */
  readDir(relativePath: string): Promise<Record<string, string>>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The field a `<name>File` key inlines into. */
export const INLINE_FIELDS: ReadonlyArray<{
  /** `spec` path to the object holding the pair. */
  at: string[];
  file: string;
  into: string;
}> = [
  { at: ["spec", "what"], file: "promptFile", into: "prompt" },
  { at: ["spec", "agent"], file: "systemPromptFile", into: "systemPrompt" },
  { at: ["spec", "agent"], file: "agentsMdFile", into: "agentsMd" },
  { at: ["spec"], file: "templateFile", into: "template" },
  { at: ["spec"], file: "promptFile", into: "prompt" },
];

function dig(doc: Record<string, unknown>, path: string[]): Record<string, unknown> | null {
  let node: unknown = doc;
  for (const key of path) {
    if (!isRecord(node)) return null;
    node = node[key];
  }
  return isRecord(node) ? node : null;
}

/**
 * The document with every `*File` field read and replaced by its target
 * field (`promptFile` → `prompt`, …) and a Skill's `filesFrom` directory
 * read into `files` (its `SKILL.md` becomes the prompt when none is given).
 * A field given both ways is an error, like a missing file. Returns a copy;
 * anything that isn't an object is returned as it is.
 */
export async function inlineManifestFiles(
  document: unknown,
  read: ManifestFileReader,
): Promise<unknown> {
  if (!isRecord(document)) return document;
  const doc = structuredClone(document);
  const kind = doc.kind;
  for (const { at, file, into } of INLINE_FIELDS) {
    // `spec.promptFile` is a Skill's; `spec.what.promptFile` is Work's.
    if (at.length === 1 && file === "promptFile" && kind !== "Skill") continue;
    const holder = dig(doc, at);
    if (!holder || typeof holder[file] !== "string") continue;
    if (holder[into] !== undefined) {
      throw new Error(`${[...at, file].join(".")} and ${[...at, into].join(".")} are both set`);
    }
    holder[into] = await read.readText(holder[file] as string);
    delete holder[file];
  }
  if (kind === "Skill") {
    const spec = dig(doc, ["spec"]);
    if (spec && typeof spec.filesFrom === "string") {
      if (spec.files !== undefined) throw new Error("spec.filesFrom and spec.files are both set");
      const files = await read.readDir(spec.filesFrom);
      const skillMd = Object.keys(files).find((p) => p.toLowerCase() === "skill.md");
      if (skillMd) {
        if (spec.prompt === undefined) spec.prompt = files[skillMd];
        delete files[skillMd];
      }
      if (spec.prompt === undefined) {
        throw new Error(`spec.filesFrom: ${spec.filesFrom} has no SKILL.md and no prompt is set`);
      }
      spec.files = files;
      if (spec.layout === undefined) spec.layout = "skill-dir";
      delete spec.filesFrom;
    }
  }
  return doc;
}

/** The `*File` fields a document still carries (ones the reader didn't inline). */
export function uninlinedFileFields(document: unknown): string[] {
  if (!isRecord(document)) return [];
  const left: string[] = [];
  for (const { at, file } of INLINE_FIELDS) {
    if (at.length === 1 && file === "promptFile" && document.kind !== "Skill") continue;
    const holder = dig(document, at);
    if (holder && holder[file] !== undefined) left.push([...at, file].join("."));
  }
  const spec = dig(document, ["spec"]);
  if (document.kind === "Skill" && spec && spec.filesFrom !== undefined)
    left.push("spec.filesFrom");
  return left;
}
