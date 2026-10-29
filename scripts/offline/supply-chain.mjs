#!/usr/bin/env node
// The offline kit's supply-chain check, the parts that read files
// (scripts/offline/kit-scan.sh runs the scanners and calls this):
//
//   node scripts/offline/supply-chain.mjs known-bad --list <file> [--images <images.txt>]
//          [--digests <digests.txt>] <sbom|dir>...
//     Every package in the CycloneDX SBOMs, and every image digest (the
//     pinned one in images.txt; the manifest and config digests kit-scan.sh
//     read from each archive into digests.txt), against the known-bad list;
//     prints each match (Markdown), exit 1 on any, 2 on a bad list or usage.
//   node scripts/offline/supply-chain.mjs summary --sbom-dir <dir> --scan-dir <dir>
//          [--db <metadata.json>] [--known-bad <its output>] [--syft <version>]
//          [--trivy <version>] [--where <the scan's place, as the text names it>]
//          [--db-file <the database's file, as the text names it>]
//     The Markdown summary KIT.md carries: packages and vulnerabilities by
//     severity per artifact, the scanner database's date, the known-bad result.
//
// The known-bad list (scripts/offline/known-bad.txt): one entry per line,
// `#` starts a comment.
//   <ecosystem>/<name>@<version>   a package-URL type (npm, pypi, golang, deb, apk,
//                                  gem, cargo, maven, …), its name (npm scopes as
//                                  @scope/name) and an exact version, or * for any.
//                                  deb, apk, rpm, alpm and maven: the namespace is
//                                  optional (deb/openssl matches pkg:deb/debian/openssl,
//                                  deb/debian/openssl only Debian's; maven/log4j-core
//                                  any group), and a deb or apk entry also matches the
//                                  packages built from that source package (Syft's
//                                  upstream qualifier: deb/xz-utils matches liblzma5)
//   */<name>@<version>             that name in any ecosystem
//   image <name>@sha256:<digest>   an image (the name is for people; the digest decides:
//                                  an index, a platform manifest or a config digest)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ── The known-bad list ────────────────────────────────────────────────────

/** A PyPI name as PEP 503 compares it; other ecosystems: lower case. */
export function normalName(ecosystem, name) {
  const n = name.trim().toLowerCase();
  return ecosystem === "pypi" ? n.replace(/[-_.]+/g, "-") : n;
}

const normalVersion = (v) => v.trim().replace(/^v(?=\d)/, "");

/** Lines of the list → { packages: [...], images: [...], errors: [...] }. */
export function parseKnownBad(text) {
  const packages = [];
  const images = [];
  const errors = [];
  text.split("\n").forEach((raw, i) => {
    const [body, ...comment] = raw.split("#");
    const line = body.trim();
    if (!line) return;
    const why = comment.join("#").trim();
    let m = /^image\s+(\S+)@(sha256:[0-9a-f]{64})$/.exec(line);
    if (m) {
      images.push({ name: m[1], digest: m[2], why, line: i + 1 });
      return;
    }
    m = /^([a-z0-9.+-]+|\*)\/(.+)@([^@\s]+)$/.exec(line);
    if (m) {
      packages.push({
        ecosystem: m[1],
        name: normalName(m[1], m[2]),
        version: m[3] === "*" ? "*" : normalVersion(m[3]),
        entry: line,
        why,
        line: i + 1,
      });
      return;
    }
    errors.push(
      `line ${i + 1}: not <ecosystem>/<name>@<version> or image <name>@sha256:<digest>: ${line}`,
    );
  });
  return { packages, images, errors };
}

/** pkg:type/namespace/name@version?q#s → { type, name, version } (decoded). */
export function parsePurl(purl) {
  const m = /^pkg:([^/]+)\/([^?#]+?)(?:@([^?#]+))?(?:[?#].*)?$/.exec(purl ?? "");
  if (!m) return null;
  const path = m[2].split("/").map(decodeURIComponent);
  return {
    type: m[1].toLowerCase(),
    name: path.join("/"),
    version: m[3] ? decodeURIComponent(m[3]) : "",
  };
}

/** Every component of a CycloneDX document, nested ones too. */
export function components(bom) {
  const out = [];
  const walk = (list) => {
    for (const c of list ?? []) {
      out.push(c);
      walk(c.components);
    }
  };
  walk(bom?.components);
  return out;
}

/**
 * The package-URL types whose namespace says where a package comes from (a
 * distribution: deb/debian, apk/alpine, rpm/redhat, alpm/arch; a Maven
 * group) instead of being part of its name. A list entry without one
 * (deb/openssl, maven/log4j-core) matches the name in any namespace; with
 * one (deb/debian/openssl) only there. Elsewhere the namespace is the name's
 * own (npm's @scope/name, a Go module's path) and an entry spells it whole.
 */
export const NAMESPACE_OPTIONAL = new Set(["deb", "apk", "rpm", "alpm", "maven"]);
/**
 * The types whose binary packages name their source package in Syft's
 * `upstream` qualifier (`name` or `name@version`): liblzma5 is built from
 * xz-utils, and advisories name the source package.
 */
const SOURCE_QUALIFIED = new Set(["deb", "apk"]);

/** A package URL's qualifiers (?k=v&…), decoded. */
export function purlQualifiers(purl) {
  const q = /\?([^#]*)/.exec(purl ?? "");
  const out = {};
  for (const kv of (q?.[1] ?? "").split("&")) {
    if (!kv) continue;
    const i = kv.indexOf("=");
    const key = decodeURIComponent(i < 0 ? kv : kv.slice(0, i)).toLowerCase();
    out[key] = i < 0 ? "" : decodeURIComponent(kv.slice(i + 1));
  }
  return out;
}

/** The names (with the version each goes with) a list entry may give a package as. */
function namesOf(p, purl, version) {
  const parts = p.name.split("/");
  const short = parts.pop();
  const namespace = parts.join("/");
  const out = [{ name: p.name, version }];
  if (namespace && NAMESPACE_OPTIONAL.has(p.type)) out.push({ name: short, version });
  const upstream = SOURCE_QUALIFIED.has(p.type) ? purlQualifiers(purl).upstream : "";
  if (upstream) {
    const at = upstream.lastIndexOf("@");
    const source = at > 0 ? upstream.slice(0, at) : upstream;
    const sourceVersion = at > 0 ? normalVersion(upstream.slice(at + 1)) : version;
    if (namespace) out.push({ name: `${namespace}/${source}`, version: sourceVersion });
    out.push({ name: source, version: sourceVersion });
  }
  return out;
}

/** The packages of one SBOM that the list names: [{ entry, why, purl, name, version }]. */
export function matchPackages(bom, list) {
  const hits = [];
  for (const c of components(bom)) {
    // Packages only: a file, the operating system or the image itself names no package.
    const p = parsePurl(c.purl);
    if (!p) continue;
    const type = p.type;
    const version = normalVersion(p.version || c.version || "");
    const names = namesOf(p, c.purl, version);
    for (const e of list.packages) {
      if (e.ecosystem !== "*" && e.ecosystem !== type) continue;
      const ecosystem = e.ecosystem === "*" ? type : e.ecosystem;
      const hit = names.find(
        (n) =>
          normalName(ecosystem, n.name) === e.name &&
          (e.version === "*" || e.version === n.version),
      );
      if (!hit) continue;
      hits.push({ entry: e.entry, why: e.why, purl: c.purl ?? `${p.name}@${version}`, version });
    }
  }
  return hits;
}

/** images.txt rows (`<kit file> <ref> <path>`) whose ref carries a listed digest. */
export function matchImages(imagesTxt, list) {
  const hits = [];
  for (const row of imagesTxt.split("\n")) {
    const [file, ref, path] = row.trim().split(/\s+/);
    if (!ref) continue;
    for (const e of list.images) {
      if (ref.includes(e.digest))
        hits.push({ entry: `image ${e.name}@${e.digest}`, why: e.why, file, ref, path });
    }
  }
  return hits;
}

/**
 * digests.txt rows (`<kit file> <digest>...`: what kit-scan.sh read from each
 * archive, its platform manifests and its config) that carry a listed digest.
 */
export function matchDigests(digestsTxt, list) {
  const hits = [];
  for (const row of digestsTxt.split("\n")) {
    const [file, ...digests] = row.trim().split(/\s+/);
    if (!file || !digests.length) continue;
    for (const e of list.images) {
      if (digests.includes(e.digest)) {
        hits.push({
          entry: `image ${e.name}@${e.digest}`,
          why: e.why,
          file,
          ref: e.digest,
          path: file,
        });
      }
    }
  }
  return hits;
}

/** The SBOM files under the given files and directories (*.cdx.json), sorted. */
export function sbomFiles(paths) {
  const out = [];
  const walk = (p) => {
    if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
    else if (p.endsWith(".cdx.json")) out.push(p);
  };
  for (const p of paths) walk(resolve(p));
  return out.sort();
}

// ── The summary ───────────────────────────────────────────────────────────

const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"];

/** A Trivy JSON report → counts by severity, fixable ones, and the critical IDs. */
export function countVulnerabilities(report) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  let fixable = 0;
  const seen = new Set();
  const critical = new Set();
  for (const r of report?.Results ?? []) {
    for (const v of r.Vulnerabilities ?? []) {
      // One finding per vulnerability and package version, whichever target listed it.
      const key = `${v.VulnerabilityID}|${v.PkgName}|${v.InstalledVersion}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sev = SEVERITIES.includes(v.Severity) ? v.Severity : "UNKNOWN";
      counts[sev]++;
      if (v.FixedVersion) fixable++;
      if (sev === "CRITICAL")
        critical.add(`${v.VulnerabilityID} (${v.PkgName} ${v.InstalledVersion})`);
    }
  }
  return { counts, fixable, total: seen.size, critical: [...critical].sort() };
}

const cell = (n) => (n ? String(n) : "0");

/** The version of a tool (Syft) that made an SBOM, from its metadata. */
export function toolVersion(bom, tool) {
  const tools = bom?.metadata?.tools;
  const list = Array.isArray(tools) ? tools : (tools?.components ?? []);
  return list.find((t) => String(t.name ?? "").toLowerCase() === tool)?.version ?? null;
}

/** The Markdown summary. */
export function summary({
  sbomDir,
  scanDir,
  dbMeta,
  knownBad,
  syft,
  trivy,
  where = "offline/scan/",
  dbFile = "offline/trivy-db.tgz",
}) {
  const rows = [];
  const totals = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  let fixable = 0;
  const critical = [];
  for (const sbom of sbomFiles([sbomDir])) {
    const rel = relative(sbomDir, sbom);
    const name = rel.replace(/\.cdx\.json$/, "");
    const bom = JSON.parse(readFileSync(sbom, "utf8"));
    syft ??= toolVersion(bom, "syft");
    const packages = components(bom).filter((c) => parsePurl(c.purl)).length;
    const reportPath = join(scanDir, `${name}.trivy.json`);
    if (!existsSync(reportPath)) {
      rows.push(`| \`${name}\` | ${packages} | not scanned | | | | | |`);
      continue;
    }
    const c = countVulnerabilities(JSON.parse(readFileSync(reportPath, "utf8")));
    for (const s of SEVERITIES) totals[s] += c.counts[s];
    fixable += c.fixable;
    critical.push(...c.critical.map((x) => `\`${name}\`: ${x}`));
    rows.push(
      `| \`${name}\` | ${packages} | ${SEVERITIES.map((s) => cell(c.counts[s])).join(" | ")} | ${cell(c.fixable)} |`,
    );
  }
  const lines = [];
  // (syft is known once the SBOMs above were read.)
  lines.push(
    `SBOMs (CycloneDX JSON, packages${syft ? `, Syft ${syft}` : ""}): \`offline/sbom/\`, one per image (PyPI and other language packages inside the images too), one for the npm packages (\`pnpm-lock.yaml\`) and one for the tools in \`offline/bin\`.`,
  );
  const db = dbMeta
    ? ` with its vulnerability database of ${String(dbMeta.UpdatedAt ?? "?").slice(0, 10)} (\`${dbFile}\`)`
    : "";
  lines.push(`Vulnerabilities (Trivy${trivy ? ` ${trivy}` : ""}${db}): \`${where}\`.`);
  lines.push("");
  lines.push("| Artifact | Packages | Critical | High | Medium | Low | Unknown | Fixable |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  lines.push(...rows);
  lines.push(
    `| **All** | | ${SEVERITIES.map((s) => `**${totals[s]}**`).join(" | ")} | **${fixable}** |`,
  );
  if (critical.length) {
    lines.push("");
    lines.push(`Critical (${critical.length}):`);
    lines.push("");
    lines.push(...critical.slice(0, 50).map((c) => `- ${c}`));
    if (critical.length > 50)
      lines.push(`- … and ${critical.length - 50} more (\`offline/scan/\`)`);
  }
  lines.push("");
  lines.push(knownBad ? knownBad.trim() : "Known-bad list: not checked.");
  return `${lines.join("\n")}\n`;
}

// ── The command ───────────────────────────────────────────────────────────

function args(argv, known) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (!known.includes(key) || i + 1 >= argv.length)
        throw new Error(`Unknown or empty option: ${a}`);
      opts[key] = argv[++i];
    } else rest.push(a);
  }
  return { opts, rest };
}

export function main(argv, out = process.stdout, err = process.stderr) {
  const [command, ...more] = argv;
  try {
    if (command === "known-bad") {
      const { opts, rest } = args(more, ["list", "images", "digests"]);
      if (!opts.list) throw new Error("known-bad needs --list <file>");
      const list = parseKnownBad(readFileSync(opts.list, "utf8"));
      if (list.errors.length) {
        err.write(`${opts.list}:\n${list.errors.map((e) => `  ${e}`).join("\n")}\n`);
        return 2;
      }
      const hits = [];
      const files = sbomFiles(rest);
      let packages = 0;
      for (const f of files) {
        const bom = JSON.parse(readFileSync(f, "utf8"));
        packages += components(bom).length;
        for (const h of matchPackages(bom, list)) hits.push({ ...h, where: basename(f) });
      }
      let images = 0;
      if (opts.images) {
        const text = readFileSync(opts.images, "utf8");
        images = text.split("\n").filter((l) => l.trim()).length;
        for (const h of matchImages(text, list)) hits.push({ ...h, where: h.path, purl: h.ref });
      }
      if (opts.digests) {
        for (const h of matchDigests(readFileSync(opts.digests, "utf8"), list)) {
          hits.push({ ...h, where: h.file, purl: h.ref });
        }
      }
      const entries = list.packages.length + list.images.length;
      const name = `\`${basename(opts.list)}\`, ${entries} ${entries === 1 ? "entry" : "entries"}`;
      if (hits.length) {
        out.write(`Known-bad list (${name}): **${hits.length} found**:\n\n`);
        for (const h of hits)
          out.write(`- \`${h.purl}\` in \`${h.where}\`: ${h.entry}${h.why ? ` (${h.why})` : ""}\n`);
        return 1;
      }
      out.write(
        `Known-bad list (${name}): none of them in ${files.length} SBOMs (${packages} components) or ${images} images.\n`,
      );
      return 0;
    }
    if (command === "summary") {
      const { opts } = args(more, [
        "sbom-dir",
        "scan-dir",
        "db",
        "known-bad",
        "syft",
        "trivy",
        "where",
        "db-file",
      ]);
      if (!opts["sbom-dir"] || !opts["scan-dir"])
        throw new Error("summary needs --sbom-dir and --scan-dir");
      out.write(
        summary({
          sbomDir: resolve(opts["sbom-dir"]),
          scanDir: resolve(opts["scan-dir"]),
          dbMeta: opts.db && existsSync(opts.db) ? JSON.parse(readFileSync(opts.db, "utf8")) : null,
          knownBad:
            opts["known-bad"] && existsSync(opts["known-bad"])
              ? readFileSync(opts["known-bad"], "utf8")
              : null,
          syft: opts.syft,
          trivy: opts.trivy,
          where: opts.where,
          dbFile: opts["db-file"],
        }),
      );
      return 0;
    }
    err.write("usage: supply-chain.mjs known-bad|summary … (see the header of this file)\n");
    return 2;
  } catch (e) {
    err.write(`${e.message}\n`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main(process.argv.slice(2));
}
