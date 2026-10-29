import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf8");
const temps = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "optio-selfhost-"));
  temps.push(dir);
  return dir;
};
afterEach(() => temps.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const runs = (file) =>
  read(file)
    .replace(/\\\n/g, " ")
    .split("\n")
    .filter((s) => s.startsWith("RUN "))
    .map((s) => s.slice(4));

describe("selfhost offline builder", () => {
  function build(options) {
    const dir = temp();
    const log = join(dir, "calls");
    const docker = join(dir, "docker");
    writeFileSync(
      docker,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$LOG"
[ "$1 $2 $3" = 'buildx version ' ] && exit 0
if [ "$1 $2 $3" = 'image inspect --format' ]; then
  printf 'sha256:fixture|1000000\\n'
  exit 0
fi
if [ "$1 $2" = 'buildx build' ]; then
  while [ $# -gt 0 ]; do
    if [ "$1" = --metadata-file ]; then shift; printf '{}' > "$1"; fi
    shift
  done
  exit 0
fi
exit 1
`,
    );
    chmodSync(docker, 0o755);
    const r = spawnSync(
      "bash",
      [join(root, "scripts/offline/build-images.sh"), "1.0.0", "--only", "web", ...options],
      {
        cwd: root,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LOG: log, BUILDKIT_HOST: "" },
        encoding: "utf8",
      },
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return readFileSync(log, "utf8");
  }
  it("normal builds keep network downloads and Google fonts", () => {
    const out = build([]);
    assert.match(out, /AGENT_CLIS=all/);
    assert.match(out, /OPTIO_OFFLINE_FONTS=0/);
    assert.doesNotMatch(out, /--network none|PNPM_OFFLINE=1|--build-context/);
  });
  it("offline builds use mirror bases, the pnpm context and local fonts without network", () => {
    const out = build(["--offline", "--registry", "registry.example.com/optio"]);
    for (const arg of [
      "--network none",
      "PNPM_OFFLINE=1",
      "OPTIO_OFFLINE_FONTS=1",
      "NODE_SLIM_IMAGE=registry.example.com/optio/base/node:26-slim-1.0.0",
      "pnpm-offline=docker-image://registry.example.com/optio/build/pnpm-offline:1.0.0",
    ])
      assert.ok(out.includes(arg), arg);
  });
});

describe("offline dependency installation", () => {
  for (const file of [
    "Dockerfile.api",
    "Dockerfile.web",
    "Dockerfile.agent",
    "images/base.Dockerfile",
  ]) {
    it(`${file} uses the pinned npm install normally and the transferred archive offline`, () => {
      const commands = runs(file)
        .filter((command) => command.includes('"$PNPM_OFFLINE"'))
        .map((command) => command.replace(/^(?:--mount=\S+\s+)+/, ""));
      const stub = ["npm", "pnpm", "tar", "mkdir", "ln"]
        .map((name) => `${name}() { printf '%s\\n' '${name}' "$*"; }`)
        .join("\n");
      const run = (flag) => {
        const result = spawnSync("sh", ["-ec", stub + "\n" + commands.join("\n")], {
          encoding: "utf8",
          env: { ...process.env, PNPM_OFFLINE: flag },
        });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      const normal = run("0");
      assert.match(normal, /install -g pnpm@10\.34\.8/);
      assert.doesNotMatch(normal, /--offline|--strip-components/);
      const offline = run("1");
      assert.match(offline, /--strip-components=2/);
      assert.match(offline, /--offline --store-dir \/pnpm-offline\/store/);
      assert.doesNotMatch(offline, /^npm$/m);
    });
  }
});
