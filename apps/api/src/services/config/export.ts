/**
 * Export: the organization's resources as manifests — the way to start a
 * configuration directory from what a workspace already has. Only the
 * organization's rows (never anyone's private ones), never secret values.
 */
import YAML from "yaml";
import {
  MANIFEST_APPLY_ORDER,
  MANIFEST_KIND_DIRS,
  type ExportedManifest,
  type Manifest,
  type ManifestKind,
} from "@optio/shared";
import { loadContext } from "./context.js";
import { HANDLERS } from "./kinds/index.js";

/** Where an export files a manifest: `work/nightly-bump.yaml`. */
export function manifestFilePath(kind: ManifestKind, name: string): string {
  const file =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "unnamed";
  return `${MANIFEST_KIND_DIRS[kind]}/${file}.yaml`;
}

export async function exportManifests(
  workspaceId: string | null,
  opts: { kinds?: ManifestKind[]; id?: string } = {},
): Promise<ExportedManifest[]> {
  const ctx = await loadContext(workspaceId);
  const kinds = opts.kinds?.length
    ? MANIFEST_APPLY_ORDER.filter((k) => opts.kinds!.includes(k))
    : MANIFEST_APPLY_ORDER;
  const out: ExportedManifest[] = [];
  for (const kind of kinds) {
    const handler = HANDLERS[kind];
    const rows = await handler.list(ctx);
    for (const row of rows) {
      const ident = handler.identify(row);
      if (opts.id && ident.id !== opts.id) continue;
      const document = (await handler.export(row, ctx)) as Manifest;
      out.push({
        kind,
        name: document.metadata.name,
        path: manifestFilePath(kind, document.metadata.name),
        document,
      });
    }
  }
  return out;
}

/** One YAML text: a header comment, then every manifest, `---` between them. */
export function manifestsToYaml(items: ExportedManifest[], schemaUrl?: string): string {
  const header = [
    schemaUrl ? `# yaml-language-server: $schema=${schemaUrl}` : null,
    "# Exported from Optio. Secrets are referenced by name, never written here.",
  ]
    .filter(Boolean)
    .join("\n");
  const docs = items.map((item) =>
    YAML.stringify(item.document, { lineWidth: 100, indent: 2, blockQuote: "literal" }).trimEnd(),
  );
  return `${header}\n${docs.join("\n---\n")}\n`;
}
