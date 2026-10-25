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

// Execute the Dockerfiles' actual shell branches with download/install commands
// replaced by functions. Nothing downloads or writes outside the fixture.
const runs = (file) =>
  read(file)
    .replace(/\\\n/g, " ")
    .split("\n")
    .filter((s) => s.startsWith("RUN "))
    .map((s) => s.slice(4));
function installs(file, overrides = {}) {
  const defaults = Object.fromEntries(
    [...read(file).matchAll(/^ARG (\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]),
  );
  const commands = runs(file).filter(
    (s) => s.startsWith("case ") || s.includes('"$PREINSTALL_MCP_SERVERS"'),
  );
  const stub = `npm() { printf 'npm %s\\n' "$*"; }
curl() { printf 'curl %s\\n' "$*" >&2; printf ':\\n'; }
codex() { printf '%s\\n' --dangerously-bypass-approvals-and-sandbox; }
readlink() { printf '/tmp/optio/cursor-agent\\n'; }
mv() { :; }; rm() { :; }; mkdir() { :; }; cp() { :; }; ln() { :; }
`;
  const r = spawnSync("sh", ["-ec", stub + commands.join("\n")], {
    env: { ...process.env, ...defaults, ...overrides },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout + r.stderr;
}

describe("selfhost images", () => {
  it("defaults to every upstream runtime and the Claude compatibility pin", () => {
    const out = installs("images/base.Dockerfile");
    for (const pkg of [
      "@anthropic-ai/claude-code@2.1.112",
      "@openai/codex",
      "@github/copilot@1.0.20",
      "@google/gemini-cli",
      "openclaw",
      "https://cursor.com/install",
      "https://opencode.ai/install",
    ])
      assert.ok(out.includes(pkg), pkg);
    assert.ok(!out.includes("@modelcontextprotocol/"));
    assert.match(read("images/base.Dockerfile"), /git curl wget jq unzip tmux tini/);
    assert.match(read("images/base.Dockerfile"), /awscli.amazonaws.com/);
  });
  it("selects only requested runtimes, preserves an alternate Claude pin and npm OpenCode", () => {
    const out = installs("images/base.Dockerfile", {
      AGENT_CLIS: "claude-code,opencode",
      CLAUDE_CODE_VERSION: "2.1.308",
      OPENCODE_INSTALL_METHOD: "npm",
    });
    assert.match(out, /@anthropic-ai\/claude-code@2\.1\.308/);
    assert.match(out, /opencode-ai@1\.14\.20/);
    for (const absent of [
      "@openai/codex",
      "@github/copilot",
      "@google/gemini-cli",
      "https://cursor.com",
      "https://opencode.ai",
    ])
      assert.ok(!out.includes(absent), absent);
  });
  it("installs the pinned MCP binaries only on request", () => {
    assert.match(
      installs("images/base.Dockerfile", { PREINSTALL_MCP_SERVERS: "1" }),
      /@modelcontextprotocol\/server-postgres@0\.6\.2 @modelcontextprotocol\/server-filesystem@2026\.8\.31/,
    );
    assert.match(
      read("images/base.Dockerfile"),
      /ENV OPTIO_MCP_PREINSTALLED=\$\{PREINSTALL_MCP_SERVERS\}/,
    );
  });
  for (const file of ["Dockerfile.api", "Dockerfile.agent"]) {
    it(`${file} includes Codex by default and supports selecting Claude alone`, () => {
      assert.match(installs(file), /@openai\/codex/);
      assert.match(installs(file), /@anthropic-ai\/claude-code@2\.1\.112/);
      assert.doesNotMatch(installs(file, { AGENT_CLIS: "claude-code" }), /@openai\/codex/);
    });
  }
  it("keeps all Docker RUN instructions syntactically valid", () => {
    for (const file of [
      "Dockerfile.api",
      "Dockerfile.agent",
      "Dockerfile.web",
      "images/base.Dockerfile",
      "images/dind.Dockerfile",
    ]) {
      assert.doesNotMatch(read(file), /OPTIO_PROFILE/);
      for (const command of runs(file)) {
        const shell = command.replace(/^(?:--mount=\S+\s+)+/, "");
        const r = spawnSync("sh", ["-n", "-c", shell], { encoding: "utf8" });
        assert.equal(r.status, 0, `${file}: ${r.stderr}`);
      }
    }
  });
});

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
      "NODE_SLIM_IMAGE=registry.example.com/optio/base/node:22-slim-1.0.0",
      "pnpm-offline=docker-image://registry.example.com/optio/build/pnpm-offline:1.0.0",
    ])
      assert.ok(out.includes(arg), arg);
  });
});

const helmAvailable = spawnSync("helm", ["version", "--short"], { encoding: "utf8" }).status === 0;
describe("selfhost chart", { skip: !helmAvailable }, () => {
  const base = [
    "template",
    "optio",
    join(root, "helm/optio"),
    "--kube-version",
    "1.33.0",
    "--set",
    "publicUrl=https://optio.example.com",
    "--set",
    "encryption.key=" + "a".repeat(64),
    "--set",
    "postgresql.auth.password=test",
  ];
  const render = (...args) => spawnSync("helm", [...base, ...args], { encoding: "utf8" });
  it("uses upstream versions, resources, and no optional resources or environment by default", () => {
    const r = render();
    assert.equal(r.status, 0, r.stderr);
    assert.match(read("helm/optio/Chart.yaml"), /version: 0\.1\.0\nappVersion: "0\.1\.0"/);
    assert.doesNotMatch(
      r.stdout,
      /kind: CronJob|kind: ServiceMonitor|name: optio-api-metrics|OPTIO_PROFILE:|name: OPTIO_PROFILE|OPTIO_GITLAB_BOT_ENABLED:|OPTIO_COMMIT_TRAILERS:/,
    );
    // Feature lists, switches and the gateway pre-flight render nothing by default.
    assert.doesNotMatch(
      r.stdout,
      /OPTIO_(RUNTIMES|GIT_PLATFORMS|TRIGGERS|TICKET_SOURCES|CONNECTION_PROVIDERS|MODEL_ACCESS|AGENT_POLICY_DEFAULTS|GATEWAY_PREFLIGHT|TEAMS_ENABLED|MERGE_CONFIRMATION|ONBOARDING|STARTER_PROMPTS|WORK_TRACEABILITY|CREDENTIAL_HEALTH_INTERVAL_MINUTES|AUDIT_RETENTION_DAYS|DIRECTORY_SYNC)\b/,
    );
    // The Namespace object, as upstream renders it.
    assert.equal(r.stdout.match(/^kind: Namespace$/gm)?.length, 1);
    assert.match(r.stdout, /cpu: "1"\n\s+memory: 1Gi/);
    assert.match(r.stdout, /cpu: 500m\n\s+memory: 512Mi/);
    // Catalog annotations are chart metadata; they never enter rendered objects.
    assert.match(read("helm/optio/Chart.yaml"), /catalog.cattle.io\/display-name: Optio/);
    assert.doesNotMatch(r.stdout, /catalog.cattle.io/);
  });
  it("requires explicit monitoring audience and dashboard namespace", () => {
    let r = render("--set", "metrics.enabled=true");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /metrics.networkPolicy.namespaces/);
    r = render(
      "--set",
      "metrics.enabled=true",
      "--set",
      "metrics.networkPolicy.namespaces[0]=monitoring",
      "--set",
      "metrics.grafanaDashboard.enabled=true",
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /metrics.grafanaDashboard.namespace/);
    r = render(
      "--set",
      "metrics.enabled=true",
      "--set",
      "metrics.networkPolicy.namespaces[0]=monitoring",
      "--set",
      "metrics.grafanaDashboard.enabled=true",
      "--set",
      "metrics.grafanaDashboard.namespace=monitoring",
      "--set",
      "backup.enabled=true",
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /kind: CronJob/);
    assert.match(r.stdout, /name: optio-api-metrics/);
    assert.match(r.stdout, /name: optio-dashboard-optio\n\s+namespace: monitoring/);
  });
  it("keeps OAuth settings alongside LDAP and OIDC, and renders explicit opt-ins", () => {
    for (const provider of ["github", "gitlab", "google"]) {
      const r = render(
        "--set",
        `auth.${provider}.clientId=client`,
        "--set",
        `auth.${provider}.clientSecret=secret`,
      );
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes(`${provider.toUpperCase()}_OAUTH_CLIENT_ID: "client"`));
    }
    const r = render(
      "--set",
      "features.runtimes={claude-code,opencode}",
      "--set",
      "modelAccess=gateway",
      "--set",
      "tickets.commitTrailers=true",
      "--set",
      "gitlab.bot.enabled=true",
      "--set",
      "redis.connectionTestTlsAware=true",
    );
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /OPTIO_PROFILE/);
    assert.match(r.stdout, /OPTIO_RUNTIMES: "claude-code,opencode"/);
    assert.match(r.stdout, /OPTIO_MODEL_ACCESS: "gateway"/);
    assert.doesNotMatch(r.stdout, /OPTIO_GIT_PLATFORMS/);
    assert.match(r.stdout, /OPTIO_COMMIT_TRAILERS: "true"/);
    assert.match(r.stdout, /OPTIO_GITLAB_BOT_ENABLED: "true"/);
    assert.match(r.stdout, /nc -z -w 5 optio-redis/);
  });
  it("leaves the Namespace out only when asked", () => {
    const r = render("--set", "createNamespace=false");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /^kind: Namespace$/m);
  });
  it("renders the gateway pre-flight only when set, so false turns it off", () => {
    for (const [value, rendered] of [
      ["false", "false"],
      ["true", "true"],
    ]) {
      const r = render("--set", `credentialHealth.gatewayPreflight=${value}`);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`OPTIO_GATEWAY_PREFLIGHT: "${rendered}"`));
    }
  });
});
