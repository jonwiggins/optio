// node --test scripts/offline/supply-chain.test.mjs
// The offline kit's supply-chain check, the parts that read files: the
// known-bad list (and the one this source ships), SBOM matching, image
// digests, Trivy counts and the summary KIT.md shows.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  countVulnerabilities,
  main,
  matchDigests,
  matchImages,
  matchPackages,
  normalName,
  parseKnownBad,
  parsePurl,
  summary,
  toolVersion,
} from "./supply-chain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const D1 = `sha256:${"a".repeat(64)}`;
const D2 = `sha256:${"b".repeat(64)}`;

const bom = (purls, extra = {}) => ({
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  metadata: { tools: { components: [{ type: "application", name: "syft", version: "1.54.1" }] } },
  components: purls.map((p) => ({ type: "library", purl: p })),
  ...extra,
});

/** main() with its output captured. */
function run(argv) {
  let out = "";
  let err = "";
  const code = main(argv, { write: (s) => (out += s) }, { write: (s) => (err += s) });
  return { code, out, err };
}

describe("the known-bad list", () => {
  it("reads packages, any-ecosystem names, images and comments; names its bad lines", () => {
    const list = parseKnownBad(
      [
        "# a comment",
        "",
        "pypi/LiteLLM@1.107.0   # credential stealer",
        "npm/@scope/pkg@v2.0.0",
        "*/event-stream@3.3.6",
        "golang/github.com/x/y@*",
        `image litellm@${D1}  # its image`,
        "nonsense",
        "image x@sha256:short",
      ].join("\n"),
    );
    assert.deepEqual(
      list.packages.map((p) => [p.ecosystem, p.name, p.version, p.why]),
      [
        ["pypi", "litellm", "1.107.0", "credential stealer"],
        ["npm", "@scope/pkg", "2.0.0", ""],
        ["*", "event-stream", "3.3.6", ""],
        ["golang", "github.com/x/y", "*", ""],
      ],
    );
    assert.deepEqual(list.images, [{ name: "litellm", digest: D1, why: "its image", line: 7 }]);
    assert.deepEqual(
      list.errors.map((e) => e.split(":")[0]),
      ["line 8", "line 9"],
    );
  });

  it("the shipped list parses and holds LiteLLM 1.107.0", () => {
    const list = parseKnownBad(readFileSync(join(HERE, "known-bad.txt"), "utf8"));
    assert.deepEqual(list.errors, []);
    assert.ok(
      list.packages.some(
        (p) => p.ecosystem === "pypi" && p.name === "litellm" && p.version === "1.107.0",
      ),
    );
  });

  it("compares PyPI names as PEP 503 does, others in lower case", () => {
    assert.equal(normalName("pypi", "LiteLLM_Proxy.Extras"), "litellm-proxy-extras");
    assert.equal(normalName("npm", "@Scope/Pkg"), "@scope/pkg");
  });
});

describe("SBOM matching", () => {
  it("parses package URLs, scoped and encoded ones too", () => {
    assert.deepEqual(parsePurl("pkg:npm/%40scope/pkg@1.0.0?x=y#z"), {
      type: "npm",
      name: "@scope/pkg",
      version: "1.0.0",
    });
    assert.deepEqual(parsePurl("pkg:golang/github.com/x/y@v1.2.3"), {
      type: "golang",
      name: "github.com/x/y",
      version: "v1.2.3",
    });
    assert.equal(parsePurl("not a purl"), null);
    assert.equal(parsePurl(undefined), null);
  });

  it("finds a listed package by ecosystem, name and version, nested components too", () => {
    const list = parseKnownBad(
      "pypi/litellm@1.107.0\n*/event-stream@3.3.6\ngolang/github.com/x/y@*\nnpm/left-pad@1.0.0\n",
    );
    const sbom = bom(
      [
        "pkg:pypi/LiteLLM@1.107.0",
        "pkg:pypi/litellm@1.106.9",
        "pkg:npm/event-stream@3.3.6",
        "pkg:golang/github.com/x/y@v0.1.0",
        "pkg:npm/left-pad@1.0.1",
      ],
      {},
    );
    sbom.components.push({
      type: "library",
      purl: "pkg:deb/debian/base@1",
      components: [{ type: "library", purl: "pkg:pypi/litellm@1.107.0" }],
    });
    // A file or the OS names no package: never a match, whatever its name.
    sbom.components.push({ type: "file", name: "event-stream", version: "3.3.6" });
    const hits = matchPackages(sbom, list).map((h) => h.purl);
    assert.deepEqual(hits, [
      "pkg:pypi/LiteLLM@1.107.0",
      "pkg:npm/event-stream@3.3.6",
      "pkg:golang/github.com/x/y@v0.1.0",
      "pkg:pypi/litellm@1.107.0",
    ]);
  });

  it("finds distribution and Maven packages with or without their namespace, as Syft writes them", () => {
    const sbom = bom([
      "pkg:deb/debian/openssl@3.0.11-1~deb12u2?arch=amd64&distro=debian-12",
      "pkg:deb/debian/liblzma5@5.6.0-0.2?arch=amd64&upstream=xz-utils&distro=debian-12",
      "pkg:deb/debian/libfoo1@1.2-3%2Bb1?arch=amd64&upstream=foo%401.2-3&distro=debian-12",
      "pkg:apk/alpine/musl@1.2.4-r2?arch=x86_64&upstream=musl&distro=alpine-3.19.0",
      "pkg:apk/alpine/libcrypto3@3.1.4-r5?arch=x86_64&upstream=openssl&distro=alpine-3.19.0",
      "pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1",
      "pkg:rpm/redhat/openssl-libs@3.0.7-25.el9?arch=x86_64&epoch=1&distro=rhel-9.3",
    ]);
    const hits = (entries) =>
      matchPackages(sbom, parseKnownBad(entries.join("\n"))).map((h) => [h.entry, h.purl]);
    const one = (entry) => hits([entry]).map(([, purl]) => purl.split("?")[0]);
    // The namespace is optional, and right when given.
    assert.deepEqual(one("deb/openssl@3.0.11-1~deb12u2"), [
      "pkg:deb/debian/openssl@3.0.11-1~deb12u2",
    ]);
    assert.deepEqual(one("deb/debian/openssl@3.0.11-1~deb12u2"), [
      "pkg:deb/debian/openssl@3.0.11-1~deb12u2",
    ]);
    assert.deepEqual(one("deb/ubuntu/openssl@3.0.11-1~deb12u2"), []);
    assert.deepEqual(one("*/openssl@3.0.11-1~deb12u2"), [
      "pkg:deb/debian/openssl@3.0.11-1~deb12u2",
    ]);
    assert.deepEqual(one("deb/openssl@3.0.11-1"), [], "the version is exact");
    assert.deepEqual(one("apk/musl@1.2.4-r2"), ["pkg:apk/alpine/musl@1.2.4-r2"]);
    assert.deepEqual(one("maven/log4j-core@2.14.1"), [
      "pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1",
    ]);
    assert.deepEqual(one("maven/org.apache.logging.log4j/log4j-core@*"), [
      "pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1",
    ]);
    assert.deepEqual(one("maven/com.example/log4j-core@2.14.1"), []);
    assert.deepEqual(one("rpm/openssl-libs@3.0.7-25.el9"), [
      "pkg:rpm/redhat/openssl-libs@3.0.7-25.el9",
    ]);
    // An advisory names the source package: the binaries built from it match.
    assert.deepEqual(one("deb/xz-utils@5.6.0-0.2"), ["pkg:deb/debian/liblzma5@5.6.0-0.2"]);
    assert.deepEqual(one("deb/debian/xz-utils@5.6.0-0.2"), ["pkg:deb/debian/liblzma5@5.6.0-0.2"]);
    assert.deepEqual(
      one("deb/foo@1.2-3"),
      ["pkg:deb/debian/libfoo1@1.2-3%2Bb1"],
      "its source version",
    );
    assert.deepEqual(one("deb/libfoo1@1.2-3+b1"), ["pkg:deb/debian/libfoo1@1.2-3%2Bb1"]);
    assert.deepEqual(one("apk/openssl@3.1.4-r5"), ["pkg:apk/alpine/libcrypto3@3.1.4-r5"]);
  });

  it("keeps an npm scope and a Go module path as part of the name", () => {
    const sbom = bom(["pkg:npm/%40evil/event-stream@3.3.6", "pkg:golang/github.com/x/y@v1.0.0"]);
    for (const entry of ["npm/event-stream@3.3.6", "*/event-stream@3.3.6", "golang/y@*", "*/y@*"]) {
      assert.deepEqual(matchPackages(sbom, parseKnownBad(entry)), [], entry);
    }
    assert.equal(matchPackages(sbom, parseKnownBad("npm/@evil/event-stream@3.3.6")).length, 1);
  });

  it("finds a listed image by its pinned digest (images.txt) or an archive's digest (digests.txt)", () => {
    const list = parseKnownBad(`image a@${D1}\nimage b@${D2}\n`);
    const images = `images/a.tar.gz docker.io/x/a:1@${D1} base/a:1\nimages/c.tar.gz docker.io/x/c:1@sha256:${"c".repeat(64)} base/c:1\n`;
    assert.deepEqual(
      matchImages(images, list).map((h) => h.path),
      ["base/a:1"],
    );
    const digests = `images/a.tar.gz sha256:${"e".repeat(64)}\nimages/c.tar.gz sha256:${"f".repeat(64)} ${D2}\n`;
    assert.deepEqual(
      matchDigests(digests, list).map((h) => [h.file, h.ref]),
      [["images/c.tar.gz", D2]],
    );
  });
});

describe("Trivy reports and the summary", () => {
  const vuln = (id, pkg, version, severity, fixed = "") => ({
    VulnerabilityID: id,
    PkgName: pkg,
    InstalledVersion: version,
    Severity: severity,
    FixedVersion: fixed,
  });

  it("counts each vulnerability of a package version once, by severity", () => {
    const c = countVulnerabilities({
      Results: [
        {
          Vulnerabilities: [
            vuln("CVE-1", "a", "1", "CRITICAL", "2"),
            vuln("CVE-2", "b", "1", "LOW"),
          ],
        },
        {
          Vulnerabilities: [
            vuln("CVE-1", "a", "1", "CRITICAL", "2"),
            vuln("CVE-3", "c", "1", "WEIRD"),
          ],
        },
        { Vulnerabilities: null },
      ],
    });
    assert.deepEqual(c.counts, { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 1, UNKNOWN: 1 });
    assert.equal(c.total, 3);
    assert.equal(c.fixable, 1);
    assert.deepEqual(c.critical, ["CVE-1 (a 1)"]);
  });

  it("reads Syft's version from an SBOM, in either CycloneDX tools form", () => {
    assert.equal(toolVersion(bom([]), "syft"), "1.54.1");
    assert.equal(
      toolVersion({ metadata: { tools: [{ name: "syft", version: "1.0" }] } }, "syft"),
      "1.0",
    );
    assert.equal(toolVersion({}, "syft"), null);
  });

  describe("the summary", () => {
    let dir;
    before(() => {
      dir = mkdtempSync(join(tmpdir(), "supply-chain-"));
      mkdirSync(join(dir, "sbom"));
      mkdirSync(join(dir, "scan"));
      writeFileSync(
        join(dir, "sbom/base-a.cdx.json"),
        JSON.stringify(bom(["pkg:apk/alpine/a@1", "pkg:apk/alpine/b@1"])),
      );
      writeFileSync(join(dir, "sbom/npm-packages.cdx.json"), JSON.stringify(bom(["pkg:npm/x@1"])));
      writeFileSync(
        join(dir, "scan/base-a.trivy.json"),
        JSON.stringify({
          Results: [
            {
              Vulnerabilities: [
                vuln("CVE-9", "a", "1", "CRITICAL", "2"),
                vuln("CVE-8", "b", "1", "HIGH"),
              ],
            },
          ],
        }),
      );
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("has a row per SBOM, the totals, the critical ones and the known-bad result", () => {
      const text = summary({
        sbomDir: join(dir, "sbom"),
        scanDir: join(dir, "scan"),
        dbMeta: { UpdatedAt: "2026-10-24T13:07:23Z" },
        knownBad: "Known-bad list: none.\n",
        trivy: "0.75.0",
      });
      assert.match(text, /Syft 1\.54\.1/);
      assert.match(
        text,
        /Trivy 0\.75\.0 with its vulnerability database of 2026-10-24 \(`offline\/trivy-db\.tgz`\)/,
      );
      assert.match(text, /\| `base-a` \| 2 \| 1 \| 1 \| 0 \| 0 \| 0 \| 1 \|/);
      assert.match(text, /\| `npm-packages` \| 1 \| not scanned \|/);
      assert.match(text, /\| \*\*All\*\* \| \| \*\*1\*\* \| \*\*1\*\* \|/);
      assert.match(text, /- `base-a`: CVE-9 \(a 1\)/);
      assert.match(text, /Known-bad list: none\./);
    });

    it("names another database file and place when a re-scan says so", () => {
      const text = summary({
        sbomDir: join(dir, "sbom"),
        scanDir: join(dir, "scan"),
        dbMeta: { UpdatedAt: "2026-11-02T00:00:00Z" },
        where: "rescan-2026-11-02/",
        dbFile: "trivy-db-2026-11-02.tgz",
      });
      assert.match(
        text,
        /database of 2026-11-02 \(`trivy-db-2026-11-02\.tgz`\)\): `rescan-2026-11-02\/`/,
      );
      assert.match(text, /Known-bad list: not checked\./);
    });
  });
});

describe("the command", () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "supply-chain-cli-"));
    mkdirSync(join(dir, "sbom"));
    writeFileSync(join(dir, "sbom/a.cdx.json"), JSON.stringify(bom(["pkg:pypi/litellm@1.106.0"])));
    writeFileSync(join(dir, "images.txt"), `images/a.tar.gz docker.io/x/a:1@${D1} base/a:1\n`);
    writeFileSync(join(dir, "digests.txt"), `images/a.tar.gz ${D2}\n`);
    writeFileSync(join(dir, "list.txt"), "pypi/litellm@1.107.0\n");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  const kb = (...more) =>
    run([
      "known-bad",
      "--list",
      join(dir, "list.txt"),
      "--images",
      join(dir, "images.txt"),
      ...more,
      join(dir, "sbom"),
    ]);

  it("known-bad: exit 0 and says what it read when nothing matches", () => {
    const r = kb("--digests", join(dir, "digests.txt"));
    assert.equal(r.code, 0, r.err);
    assert.match(
      r.out,
      /\(`list\.txt`, 1 entry\): none of them in 1 SBOMs \(1 components\) or 1 images/,
    );
  });

  it("known-bad: exit 1 with each match, a package or an archive's digest", () => {
    writeFileSync(join(dir, "sbom/b.cdx.json"), JSON.stringify(bom(["pkg:pypi/litellm@1.107.0"])));
    writeFileSync(join(dir, "list.txt"), `pypi/litellm@1.107.0 # stealer\nimage a@${D2}\n`);
    const r = kb("--digests", join(dir, "digests.txt"));
    assert.equal(r.code, 1);
    assert.match(r.out, /\*\*2 found\*\*/);
    assert.match(
      r.out,
      /- `pkg:pypi\/litellm@1\.107\.0` in `b\.cdx\.json`: pypi\/litellm@1\.107\.0 \(stealer\)/,
    );
    assert.match(r.out, new RegExp(`- \`${D2}\` in \`images/a\\.tar\\.gz\`: image a@${D2}`));
    rmSync(join(dir, "sbom/b.cdx.json"));
    writeFileSync(join(dir, "list.txt"), "pypi/litellm@1.107.0\n");
  });

  it("known-bad: exit 2 on a line it can't read, or without --list", () => {
    writeFileSync(join(dir, "bad.txt"), "litellm 1.107.0\n");
    const r = run(["known-bad", "--list", join(dir, "bad.txt"), join(dir, "sbom")]);
    assert.equal(r.code, 2);
    assert.match(r.err, /line 1: not <ecosystem>\/<name>@<version>/);
    assert.equal(run(["known-bad", join(dir, "sbom")]).code, 2);
    assert.equal(run(["nothing"]).code, 2);
    assert.equal(run(["known-bad", "--nope", "x"]).code, 2);
  });

  it("summary: needs --sbom-dir and --scan-dir", () => {
    assert.equal(run(["summary", "--sbom-dir", join(dir, "sbom")]).code, 2);
    const r = run(["summary", "--sbom-dir", join(dir, "sbom"), "--scan-dir", join(dir, "sbom")]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\| `a` \| 1 \| not scanned \|/);
  });
});
