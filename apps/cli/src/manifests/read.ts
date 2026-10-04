/**
 * Reading manifests for `optio apply` / `optio diff`: files and directories
 * (`*.yaml` / `*.yml`, recursively, dot-entries skipped), every document in
 * each, with `*File` fields read from next to the file — the same inlining
 * the API does for a configuration directory (`inlineManifestFiles` in
 * @optio/shared), so a directory applies the same either way.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { inlineManifestFiles, type ManifestFileReader, type ManifestInput } from "@optio/shared";

export interface ReadProblem {
  path: string;
  message: string;
}

export interface ReadResult {
  manifests: ManifestInput[];
  problems: ReadProblem[];
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) yield full;
  }
}

function readerFor(file: string): ManifestFileReader {
  const dir = path.dirname(file);
  return {
    readText: (rel) => fs.readFile(path.resolve(dir, rel), "utf8"),
    async readDir(rel) {
      const root = path.resolve(dir, rel);
      const out: Record<string, string> = {};
      const visit = async (current: string, prefix: string) => {
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) continue;
          const full = path.join(current, entry.name);
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await visit(full, relPath);
          else if (entry.isFile()) out[relPath] = await fs.readFile(full, "utf8");
        }
      };
      await visit(root, "");
      return out;
    },
  };
}

/** Every manifest in the given files and directories, paths shown relative to the cwd. */
export async function readManifests(targets: string[], cwd = process.cwd()): Promise<ReadResult> {
  const files: string[] = [];
  for (const target of targets) {
    const full = path.resolve(cwd, target);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) for await (const f of walk(full)) files.push(f);
    else files.push(full);
  }
  const manifests: ManifestInput[] = [];
  const problems: ReadProblem[] = [];
  for (const file of files) {
    const shown = path.relative(cwd, file).split(path.sep).join("/") || path.basename(file);
    const text = await fs.readFile(file, "utf8");
    const documents = YAML.parseAllDocuments(text);
    const many = documents.length > 1;
    for (const [index, doc] of documents.entries()) {
      const docPath = many ? `${shown}#${index + 1}` : shown;
      if (doc.errors.length) {
        problems.push({
          path: docPath,
          message: doc.errors.map((e) => e.message.split("\n")[0]).join("; "),
        });
        continue;
      }
      const value = doc.toJS() as unknown;
      if (value === null || value === undefined) continue;
      try {
        manifests.push({
          path: docPath,
          document: await inlineManifestFiles(value, readerFor(file)),
        });
      } catch (err) {
        problems.push({ path: docPath, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { manifests, problems };
}
