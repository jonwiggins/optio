/**
 * Reading a configuration directory: every `*.yaml` / `*.yml` under it
 * (recursively, dot-entries skipped), each file's documents parsed, their
 * `*File` fields read from next to the file, and a hash of the whole tree.
 * A file that doesn't parse is one error item; the rest still apply.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  inlineManifestFiles,
  type ConfigPlanItem,
  type ManifestFileReader,
  type ManifestInput,
} from "@optio/shared";

export interface DirectoryRead {
  manifests: ManifestInput[];
  errors: ConfigPlanItem[];
  /** A short hash of every file's path and contents. */
  hash: string;
  /** How many files were read. */
  files: number;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * A directory entry's kind, following symlinks: a ConfigMap mount is a
 * directory of symlinks into a `..data` snapshot, so `Dirent.isFile()` alone
 * would see nothing there.
 */
async function kindOf(
  full: string,
  entry: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean },
) {
  if (!entry.isSymbolicLink())
    return entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other";
  try {
    const stat = await fs.stat(full);
    return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
  } catch {
    return "other"; // a dangling link
  }
}

async function* walk(root: string, dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    const kind = await kindOf(full, entry);
    if (kind === "dir") yield* walk(root, full);
    else if (kind === "file" && /\.ya?ml$/i.test(entry.name)) yield full;
  }
}

/** Files a manifest names must stay inside the directory. */
function inside(root: string, candidate: string): string {
  const resolved = path.resolve(candidate);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`${candidate} is outside the configuration directory`);
  }
  return resolved;
}

/** A reader for the `*File` fields of a manifest at `file`. */
export function readerFor(root: string, file: string): ManifestFileReader {
  const dir = path.dirname(file);
  return {
    async readText(relativePath) {
      const target = inside(root, path.resolve(dir, relativePath));
      const stat = await fs.stat(target);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`${relativePath} is larger than 2 MiB`);
      return fs.readFile(target, "utf8");
    },
    async readDir(relativePath) {
      const target = inside(root, path.resolve(dir, relativePath));
      const out: Record<string, string> = {};
      const visit = async (current: string, rel: string) => {
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) continue;
          const full = path.join(current, entry.name);
          const relPath = rel ? `${rel}/${entry.name}` : entry.name;
          const kind = await kindOf(full, entry);
          if (kind === "dir") await visit(full, relPath);
          else if (kind === "file") {
            const stat = await fs.stat(full);
            if (stat.size > MAX_FILE_BYTES) throw new Error(`${relPath} is larger than 2 MiB`);
            out[relPath] = await fs.readFile(full, "utf8");
          }
        }
      };
      await visit(target, "");
      return out;
    },
  };
}

/** The documents of one YAML file, `*File` fields inlined; parse problems as error items. */
export async function readManifestFile(
  root: string,
  file: string,
): Promise<{ manifests: ManifestInput[]; errors: ConfigPlanItem[]; text: string }> {
  const relative = path.relative(root, file).split(path.sep).join("/");
  const text = await fs.readFile(file, "utf8");
  const manifests: ManifestInput[] = [];
  const errors: ConfigPlanItem[] = [];
  const documents = YAML.parseAllDocuments(text);
  const many = documents.length > 1;
  for (const [index, doc] of documents.entries()) {
    const docPath = many ? `${relative}#${index + 1}` : relative;
    if (doc.errors.length) {
      errors.push({
        kind: "?",
        name: "?",
        path: docPath,
        action: "error",
        message: doc.errors.map((e) => e.message.split("\n")[0]).join("; "),
      });
      continue;
    }
    const value = doc.toJS() as unknown;
    if (value === null || value === undefined) continue;
    try {
      manifests.push({
        path: docPath,
        document: await inlineManifestFiles(value, readerFor(root, file)),
      });
    } catch (err) {
      const label = (value ?? {}) as { kind?: unknown; metadata?: { name?: unknown } };
      errors.push({
        kind: typeof label.kind === "string" ? label.kind : "?",
        name: typeof label.metadata?.name === "string" ? label.metadata.name : "?",
        path: docPath,
        action: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { manifests, errors, text };
}

/** Every manifest under `root`. Throws when the directory can't be read at all. */
export async function readManifestDirectory(root: string): Promise<DirectoryRead> {
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error(`${root} is not a directory`);
  const manifests: ManifestInput[] = [];
  const errors: ConfigPlanItem[] = [];
  const hash = createHash("sha256");
  let files = 0;
  for await (const file of walk(root, root)) {
    files++;
    const read = await readManifestFile(root, file);
    hash.update(path.relative(root, file)).update("\0").update(read.text).update("\0");
    manifests.push(...read.manifests);
    errors.push(...read.errors);
  }
  return { manifests, errors, hash: hash.digest("hex").slice(0, 12), files };
}
