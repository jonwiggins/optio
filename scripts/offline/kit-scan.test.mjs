// node --test scripts/offline/kit-scan.test.mjs
// kit-scan.sh against a small kit made here, with a stand-in `docker` (and
// `trivy`) on PATH that plays Syft and Trivy from fixtures: each image
// archive carries packages.txt (its package URLs), and a package named
// vuln-* has a critical vulnerability. Needs bash, tar, gzip and node; no
// docker, no network.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SYFT = "docker.io/anchore/syft:v1.54.1@sha256:" + "1".repeat(64);
const TRIVY = "docker.io/aquasec/trivy:0.75.0@sha256:" + "2".repeat(64);
const M_A = `sha256:${"a".repeat(64)}`;
const C_A = "c".repeat(64);
const M_B = `sha256:${"b".repeat(64)}`;

// The stand-in: `docker run … <image> <args>` with the mounts mapped back to
// this machine's paths; `docker load`; `docker info`; and `trivy` itself.
const FAKE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const log = (s) => fs.appendFileSync(process.env.FAKE_LOG, s + "\n");
let argv = process.argv.slice(2);
const me = path.basename(process.argv[1]);
let mounts = [];
let image = me === "trivy" ? "trivy" : null;
if (me === "docker") {
  const cmd = argv.shift();
  if (cmd === "info") process.exit(0);
  if (cmd === "load") {
    fs.readFileSync(0);
    log("docker load");
    // An archive saved by tag@digest may load with no tag at all.
    console.log(process.env.FAKE_LOAD_ID ? "Loaded image ID: sha256:" + "e".repeat(64) : "Loaded image: aquasec/trivy:0.75.0");
    process.exit(0);
  }
  if (cmd !== "run") process.exit(3);
  const takes = new Set(["--platform", "--user", "-e", "-v", "--network"]);
  let net = "";
  while (argv[0].startsWith("-")) {
    const f = argv.shift();
    if (f === "--rm") continue;
    if (!takes.has(f)) { console.error("fake docker: " + f); process.exit(3); }
    const v = argv.shift();
    if (f === "-v") { const [h, c] = v.split(":"); mounts.push([c, h]); }
    if (f === "--network") net = v;
  }
  image = argv.shift();
  log("run " + (image.includes("syft") ? "syft" : "trivy") + " network=" + (net || "default") + " " + argv[0]);
}
mounts.sort((a, b) => b[0].length - a[0].length);
const host = (p) => {
  for (const [c, h] of mounts) if (p === c || p.startsWith(c + "/")) return h + p.slice(c.length);
  return p;
};
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
// FAKE_FAIL=syft|sbom: that scanner fails the way Syft and Trivy do, with status 1.
if (process.env.FAKE_FAIL === (image.includes("syft") ? "syft" : argv[0])) { console.error("scanner failed"); process.exit(1); }
if (image.includes("syft")) {
  // scan <source> -o cyclonedx-json=<file> -q [--source-name n] [--source-version v]
  const src = argv[1];
  const out = host(opt("-o").replace(/^cyclonedx-json=/, ""));
  let purls = [];
  if (src.startsWith("docker-archive:")) {
    const tar = host(src.slice("docker-archive:".length));
    purls = execFileSync("tar", ["-xOf", tar, "packages.txt"], { encoding: "utf8" }).split("\n").filter(Boolean);
  } else {
    const dir = host(src.slice("dir:".length));
    for (const f of fs.readdirSync(dir)) {
      purls.push(f === "pnpm-lock.yaml" ? "pkg:npm/fastify@5.0.0" : "pkg:generic/" + f + "@1");
    }
  }
  fs.writeFileSync(out, JSON.stringify({
    bomFormat: "CycloneDX", specVersion: "1.6",
    metadata: { tools: { components: [{ name: "syft", version: "1.54.1" }] },
      component: { name: opt("--source-name"), version: opt("--source-version") } },
    components: purls.map((purl) => ({ type: "library", name: purl.split("/").pop().split("@")[0], purl })),
  }));
} else if (argv.includes("--download-db-only")) {
  const db = path.join(host(opt("--cache-dir")), "db");
  fs.mkdirSync(db, { recursive: true });
  fs.writeFileSync(path.join(db, "trivy.db"), "fake");
  fs.writeFileSync(path.join(db, "metadata.json"), JSON.stringify({ Version: 2, UpdatedAt: "2026-10-24T13:07:23Z" }));
} else if (argv[0] === "--version") {
  // The kit's image is Trivy 0.75.0; the binary on this machine a newer one.
  console.log(me === "trivy" ? "Version: 0.75.9" : "Version: 0.75.0");
} else {
  // sbom … --output <file> <sbom> (flags after the SBOM too)
  if (!fs.existsSync(path.join(host(opt("--cache-dir")), "db", "trivy.db"))) { console.error("no db"); process.exit(1); }
  for (const f of ["--skip-db-update", "--offline-scan"]) if (!argv.includes(f)) { console.error("missing " + f); process.exit(1); }
  const sbom = host(argv.find((a, i) => a.endsWith(".cdx.json") && argv[i - 1] !== "--output"));
  const bom = JSON.parse(fs.readFileSync(sbom, "utf8"));
  const vulns = bom.components.filter((c) => c.name.startsWith("vuln-")).map((c) => ({
    VulnerabilityID: "CVE-2026-" + c.name.length, PkgName: c.name, InstalledVersion: "1", Severity: "CRITICAL", FixedVersion: "2" }));
  fs.writeFileSync(host(opt("--output")), JSON.stringify({ Results: [{ Target: "x", Vulnerabilities: vulns }] }));
}
`;

let dir;
let kit;
let bin;
let logFile;
const write = (p, text) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
/** An image archive as docker save writes one, with the packages the fake Syft reports. */
function image(file, manifest, config, purls) {
  const d = mkdtempSync(join(dir, "img-"));
  write(
    join(d, "index.json"),
    JSON.stringify({ manifests: [{ digest: manifest, platform: { architecture: "amd64" } }] }),
  );
  write(
    join(d, "manifest.json"),
    JSON.stringify([{ Config: `blobs/sha256/${config}`, RepoTags: ["x:1"] }]),
  );
  write(join(d, "packages.txt"), purls.join("\n") + "\n");
  mkdirSync(dirname(join(kit, "offline", file)), { recursive: true });
  // Plain member names, as docker save writes them (no ./).
  execFileSync("bash", [
    "-c",
    `tar -C "${d}" -cf - index.json manifest.json packages.txt | gzip -1 > "${join(kit, "offline", file)}"`,
  ]);
}
function scan(args, env = {}, cwd = SRC) {
  writeFileSync(logFile, "");
  const r = spawnSync("bash", [join(SRC, "scripts/offline/kit-scan.sh"), ...args], {
    cwd,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_LOG: logFile,
      KIT_SCAN_TMP: join(dir, "tmp"),
      ...env,
    },
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, log: readFileSync(logFile, "utf8") };
}
/** Every file under a directory with its hash: what "the kit is unchanged" compares. */
function tree(root) {
  const out = {};
  const walk = (p) => {
    for (const f of readdirSync(p)) {
      const q = join(p, f);
      if (statSync(q).isDirectory()) walk(q);
      else out[q.slice(root.length)] = createHash("sha256").update(readFileSync(q)).digest("hex");
    }
  };
  walk(root);
  return out;
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-scan-"));
  kit = join(dir, "kit-1.0.0-1");
  bin = join(dir, "bin");
  logFile = join(dir, "log");
  mkdirSync(bin);
  writeFileSync(join(bin, "fake.cjs"), FAKE);
  chmodSync(join(bin, "fake.cjs"), 0o755);
  symlinkSync(join(bin, "fake.cjs"), join(bin, "docker"));
  symlinkSync(join(bin, "fake.cjs"), join(bin, "trivy"));
  image("images/base-a-1.tar.gz", M_A, C_A, ["pkg:apk/alpine/musl@1.2", "pkg:pypi/vuln-thing@1"]);
  image("images/toolchain-b-1.0.0-1.tar.gz", M_B, "d".repeat(64), ["pkg:npm/left-pad@1.0.0"]);
  image("images/base-trivy-0.75.0.tar.gz", `sha256:${"e".repeat(64)}`, "f".repeat(64), [
    "pkg:golang/trivy@0.75.0",
  ]);
  write(
    join(kit, "offline/images.txt"),
    [
      `images/base-a-1.tar.gz docker.io/x/a:1@${M_A} base/a:1`,
      `images/base-a-1.tar.gz docker.io/x/a:1@${M_A} base/a:1-1.0.0-1`,
      "images/toolchain-b-1.0.0-1.tar.gz optio.local/toolchain/b:1.0.0-1 toolchain/b:1.0.0-1",
      `images/base-trivy-0.75.0.tar.gz ${TRIVY} base/trivy:0.75.0`,
    ].join("\n") + "\n",
  );
  write(join(kit, "offline/bin/helm"), "helm");
  write(join(kit, "offline/pnpm-offline-1.0.0-1.tgz"), "store");
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("kit-scan.sh, the connected side", () => {
  let r;
  before(() => {
    r = scan([kit, "--syft-image", SYFT, "--trivy-image", TRIVY]);
  });

  it("succeeds, and writes an SBOM per image archive, the npm packages and the tools", () => {
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(readdirSync(join(kit, "offline/sbom")).sort(), [
      "base-a-1.cdx.json",
      "base-trivy-0.75.0.cdx.json",
      "digests.txt",
      "npm-packages.cdx.json",
      "toolchain-b-1.0.0-1.cdx.json",
      "tools.cdx.json",
    ]);
    const a = JSON.parse(readFileSync(join(kit, "offline/sbom/base-a-1.cdx.json"), "utf8"));
    // Named after the image it is, not the unpacked file.
    assert.deepEqual(a.metadata.component, { name: "docker.io/x/a:1", version: M_A });
    const tools = JSON.parse(readFileSync(join(kit, "offline/sbom/tools.cdx.json"), "utf8"));
    assert.deepEqual(
      tools.components.map((c) => c.purl),
      ["pkg:generic/helm@1"],
    );
  });

  it("records each archive's manifest and config digests", () => {
    const rows = readFileSync(join(kit, "offline/sbom/digests.txt"), "utf8").trim().split("\n");
    assert.equal(rows.length, 3);
    assert.equal(rows[0], `images/base-a-1.tar.gz ${M_A} sha256:${C_A}`);
  });

  it("runs Syft and the scans with no network; only the database download has one", () => {
    const runs = r.log.trim().split("\n");
    assert.equal(runs.filter((l) => l.startsWith("run syft network=none scan")).length, 5);
    assert.deepEqual(
      runs.filter((l) => l.startsWith("run trivy")),
      [
        "run trivy network=default image",
        "run trivy network=none --version",
        ...Array(5).fill("run trivy network=none sbom"),
      ],
    );
  });

  it("ships the database, a report per SBOM, the known-bad result and the summary", () => {
    assert.ok(existsSync(join(kit, "offline/trivy-db.tgz")));
    const listing = execFileSync("tar", ["-tzf", join(kit, "offline/trivy-db.tgz")], {
      encoding: "utf8",
    });
    assert.match(listing, /db\/trivy\.db/);
    assert.match(listing, /db\/metadata\.json/);
    const scanned = readdirSync(join(kit, "offline/scan")).sort();
    assert.ok(scanned.includes("base-a-1.trivy.json"));
    assert.ok(scanned.includes("npm-packages.trivy.json"));
    const known = readFileSync(join(kit, "offline/scan/KNOWN-BAD.md"), "utf8");
    assert.match(known, /none of them in 5 SBOMs/);
    const summary = readFileSync(join(kit, "offline/scan/SUMMARY.md"), "utf8");
    assert.match(summary, /Syft 1\.54\.1/);
    assert.match(
      summary,
      /Trivy 0\.75\.0 with its vulnerability database of 2026-10-24 \(`offline\/trivy-db\.tgz`\)\): `offline\/scan\/`/,
    );
    assert.match(summary, /\| `base-a-1` \| 2 \| 1 \|/);
    assert.match(summary, /- `base-a-1`: CVE-2026-\d+ \(vuln-thing 1\)/);
  });

  it("exits 2, not the known-bad 1, when Syft fails, and leaves no scratch files", () => {
    const bad = scan([kit, "--syft-image", SYFT, "--trivy-image", TRIVY], { FAKE_FAIL: "syft" });
    assert.equal(bad.status, 2, bad.out);
    assert.deepEqual(readdirSync(join(dir, "tmp")), []);
  });

  it("fails (exit 1) when a package on the shipped list is in an image, and says which", () => {
    image("images/toolchain-b-1.0.0-1.tar.gz", M_B, "d".repeat(64), ["pkg:pypi/LiteLLM@1.107.0"]);
    const bad = scan([kit, "--syft-image", SYFT, "--trivy-image", TRIVY]);
    assert.equal(bad.status, 1, bad.out);
    assert.match(bad.out, /\*\*1 found\*\*/);
    assert.match(bad.out, /`pkg:pypi\/LiteLLM@1\.107\.0` in `toolchain-b-1\.0\.0-1\.cdx\.json`/);
    assert.match(bad.out, /don't carry it in/);
    image("images/toolchain-b-1.0.0-1.tar.gz", M_B, "d".repeat(64), ["pkg:npm/left-pad@1.0.0"]);
    assert.equal(scan([kit, "--syft-image", SYFT, "--trivy-image", TRIVY]).status, 0);
  });
});

describe("kit-scan.sh --offline, inside", () => {
  it("scans the kit's SBOMs again with the kit's Trivy and database, into --out; the kit stays as it was", () => {
    const before = tree(kit);
    const out = join(dir, "rescan");
    const r = scan([kit, "--offline", "--out", out]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(tree(kit), before);
    assert.match(r.log, /docker load/);
    assert.doesNotMatch(r.log, /run syft/);
    assert.doesNotMatch(r.log, /network=default/);
    const summary = readFileSync(join(out, "SUMMARY.md"), "utf8");
    assert.match(summary, /Syft 1\.54\.1/);
    assert.match(summary, /\(`offline\/trivy-db\.tgz`\)\): `rescan\/`/);
  });

  it("fails on an image digest a newer list names, with a newer database and $TRIVY", () => {
    const list = join(dir, "newer-list.txt");
    writeFileSync(list, `image b@${M_B}  # an advisory after the kit was made\n`);
    const db = join(dir, "trivy-db-2026-11-02.tgz");
    execFileSync("cp", [join(kit, "offline/trivy-db.tgz"), db]);
    const out = join(dir, "rescan-2");
    const r = scan([kit, "--offline", "--known-bad", list, "--db", db, "--out", out], {
      TRIVY: join(bin, "trivy"),
    });
    assert.equal(r.status, 1, r.out);
    assert.doesNotMatch(r.log, /docker/);
    assert.match(
      readFileSync(join(out, "KNOWN-BAD.md"), "utf8"),
      /images\/toolchain-b-1\.0\.0-1\.tar\.gz/,
    );
    const summary = readFileSync(join(out, "SUMMARY.md"), "utf8");
    assert.match(summary, /Trivy 0\.75\.9/);
    assert.match(summary, /\(`trivy-db-2026-11-02\.tgz`\)/);
  });

  it("takes the caller's relative paths, as KIT.md says to run it from the kit", () => {
    const r = scan(
      [".", "--offline", "--out", "rescan-relative"],
      { TRIVY: join(bin, "trivy") },
      kit,
    );
    assert.equal(r.status, 0, r.out);
    assert.ok(existsSync(join(kit, "rescan-relative/SUMMARY.md")));
    rmSync(join(kit, "rescan-relative"), { recursive: true });
  });

  it("reads Trivy's version from Trivy, when docker load names the kit's image by its ID", () => {
    const out = join(dir, "rescan-id");
    const r = scan([kit, "--offline", "--out", out], { FAKE_LOAD_ID: "1" });
    assert.equal(r.status, 0, r.out);
    const summary = readFileSync(join(out, "SUMMARY.md"), "utf8");
    assert.match(summary, /Trivy 0\.75\.0 with its vulnerability database/);
    assert.doesNotMatch(summary, /Trivy e{64}/);
  });

  it("exits 2, not the known-bad 1, when a scanner fails", () => {
    const r = scan([kit, "--offline", "--out", join(dir, "rescan-fail")], {
      TRIVY: join(bin, "trivy"),
      FAKE_FAIL: "sbom",
    });
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /scanner failed/);
    assert.doesNotMatch(r.out, /don't carry it in/);
  });

  it("says what is missing: SBOMs, a database", () => {
    const bare = join(dir, "bare-kit");
    mkdirSync(join(bare, "offline"), { recursive: true });
    writeFileSync(join(bare, "offline/images.txt"), "");
    const r = scan([bare, "--offline"], { TRIVY: join(bin, "trivy") });
    assert.equal(r.status, 2);
    assert.match(r.out, /has no SBOMs/);
    const r2 = scan([kit, "--offline", "--db", join(dir, "nope.tgz")], {
      TRIVY: join(bin, "trivy"),
    });
    assert.equal(r2.status, 2);
    assert.match(r2.out, /No such database/);
  });
});

describe("kit-scan.sh usage", () => {
  it("exit 2 without a kit, on a directory that isn't one, and without the scanners' images", () => {
    assert.equal(scan([]).status, 2);
    assert.match(scan([dir]).out, /is not a kit/);
    assert.match(scan([kit]).out, /--trivy-image is needed/);
    assert.match(scan([kit, "--trivy-image", TRIVY]).out, /--syft-image is needed/);
    assert.equal(scan([kit, "--bogus"]).status, 2);
  });
});
