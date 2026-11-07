/**
 * `optio export` — the organization's resources as manifests: to stdout as
 * one YAML stream, or with `-o DIR` one file per resource
 * (`work/<name>.yaml`, `prompts/<name>.yaml`, …), the way to start a
 * configuration directory from what a workspace already has. Never anyone's
 * private resources, never a secret's value. `--kind workspace` exports the
 * deployment's workspaces instead (`workspaces/<slug>.yaml`, a deployment
 * admin's; docs/workspaces-as-code.md).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import YAML from "yaml";
import {
  MANIFEST_KINDS,
  WORKSPACE_MANIFEST_KIND,
  type ExportedManifest,
  type ExportedWorkspaceManifest,
  type ManifestKind,
} from "@optio/shared";
import { buildClient } from "../api/client.js";
import { dim, green } from "../output/colors.js";
import { isJsonMode, outputJson } from "../output/formatter.js";
import { friendlyError } from "../utils/errors.js";

type ExportKind = ManifestKind | typeof WORKSPACE_MANIFEST_KIND;
const EXPORT_KINDS: readonly ExportKind[] = [...MANIFEST_KINDS, WORKSPACE_MANIFEST_KIND];

/** `work`, `mcp-server`, `McpServer`, `workspace` … → the manifest kind. */
export function parseKinds(value: string | undefined): ExportKind[] | undefined {
  if (!value) return undefined;
  const byLower = new Map(EXPORT_KINDS.map((k) => [k.toLowerCase().replace(/-/g, ""), k]));
  return value.split(",").map((raw) => {
    const kind = byLower.get(
      raw
        .trim()
        .toLowerCase()
        .replace(/[-_\s]/g, ""),
    );
    if (!kind) throw new Error(`Unknown kind "${raw.trim()}". One of: ${EXPORT_KINDS.join(", ")}`);
    return kind;
  });
}

type Exported = ExportedManifest | ExportedWorkspaceManifest;

/**
 * What the export asks the server for: the workspace's resources (by kind),
 * and, with `--kind workspace`, the deployment's workspaces (a deployment
 * admin's export). Without `--kind` it is the workspace's resources only.
 */
async function fetchExport(
  client: ReturnType<typeof buildClient>,
  kinds: ExportKind[] | undefined,
): Promise<Exported[]> {
  const resourceKinds = kinds?.filter((k): k is ManifestKind => k !== WORKSPACE_MANIFEST_KIND);
  const out: Exported[] = [];
  if (kinds?.includes(WORKSPACE_MANIFEST_KIND)) {
    const { manifests } = await client.get<{ manifests: ExportedWorkspaceManifest[] }>(
      "/api/config/workspaces/export",
    );
    out.push(...manifests);
  }
  if (!kinds || resourceKinds!.length) {
    const query = resourceKinds ? `?kind=${encodeURIComponent(resourceKinds.join(","))}` : "";
    const { manifests } = await client.get<{ manifests: ExportedManifest[] }>(
      `/api/config/export${query}`,
    );
    out.push(...manifests);
  }
  return out;
}

function toYaml(doc: unknown): string {
  return YAML.stringify(doc, { lineWidth: 100, indent: 2, blockQuote: "literal" }).trimEnd();
}

export const exportCommand = new Command("export")
  .description("Export the organization's resources as YAML manifests")
  .option(
    "--kind <kinds>",
    "Comma-separated kinds: work, prompt, repo, mcp-server, skill, connection; " +
      "workspace exports the deployment's workspaces (deployment admins)",
  )
  .option("--name <name>", "Only the resource with this name")
  .option("-o, --out <dir>", "Write one file per resource under this directory")
  .action(async (opts: { kind?: string; name?: string; out?: string }, cmd) => {
    try {
      const kinds = parseKinds(opts.kind);
      const client = buildClient(cmd.optsWithGlobals());
      const manifests = await fetchExport(client, kinds);
      const picked = opts.name ? manifests.filter((m) => m.name === opts.name) : manifests;
      if (opts.name && picked.length === 0) {
        process.stderr.write(
          `Nothing named "${opts.name}"${kinds ? ` of kind ${kinds.join(", ")}` : ""}.\n`,
        );
        process.exitCode = 1;
        return;
      }
      const schema = `# yaml-language-server: $schema=${client.serverUrl}/api/config/schema.json`;

      if (opts.out) {
        for (const m of picked) {
          const file = path.resolve(opts.out, m.path);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, `${schema}\n${toYaml(m.document)}\n`);
          if (!isJsonMode())
            process.stdout.write(`${green("wrote")} ${path.relative(process.cwd(), file)}\n`);
        }
        if (isJsonMode())
          outputJson(picked.map((m) => ({ kind: m.kind, name: m.name, path: m.path })));
        else
          process.stdout.write(dim(`${picked.length} manifest${picked.length === 1 ? "" : "s"}\n`));
        return;
      }

      if (isJsonMode()) {
        outputJson(picked);
        return;
      }
      process.stdout.write(`${schema}\n${picked.map((m) => toYaml(m.document)).join("\n---\n")}\n`);
    } catch (err) {
      friendlyError(err);
    }
  });
