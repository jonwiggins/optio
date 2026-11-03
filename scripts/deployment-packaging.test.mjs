import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../apps/cli/package.json", import.meta.url));
const { parse } = require("yaml");
const read = (file) => readFileSync(join(root, file), "utf8");
const temps = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "optio-packaging-"));
  temps.push(dir);
  return dir;
};
afterEach(() => temps.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const chart = parse(read("helm/optio/values.yaml"));
const pkg = parse(read("deploy/zarf/zarf.yaml"));
const variables = Object.fromEntries(pkg.variables.map((value) => [value.name, value]));
function packageValues() {
  return read("deploy/zarf/values/optio.yaml").replace(/###ZARF_VAR_(\w+)###/g, (_, name) => {
    assert.ok(variables[name], `undeclared variable ${name}`);
    return (
      {
        ENCRYPTION_KEY: "a".repeat(64),
        POSTGRES_PASSWORD: "render-only",
        PUBLIC_URL: "https://optio.example.com",
      }[name] ??
      variables[name].default ??
      ""
    );
  });
}
function supported(path) {
  let current = chart;
  for (const key of path) {
    if (current === null || typeof current !== "object" || !(key in current)) return false;
    current = current[key];
  }
  return true;
}
function checkValues(value, path = []) {
  assert.ok(supported(path), `unsupported value ${path.join(".")}`);
  if (value && !Array.isArray(value) && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) checkValues(child, [...path, key]);
  }
}

describe("deployment package metadata", () => {
  it("keeps package overrides and form fields within supported chart values", () => {
    checkValues(parse(packageValues()));
    checkValues(parse(read("deploy/zarf/example-values.yaml")).chart);
    for (const question of parse(read("helm/optio/questions.yaml")).questions) {
      if (question.variable === "rancherForm.signIn") {
        assert.deepEqual(question.options, ["github", "gitlab", "google", "oidc", "wizard"]);
        continue;
      }
      if (question.variable.startsWith("ingress.tls.0.")) continue;
      assert.ok(supported(question.variable.split(".")), question.variable);
    }
  });
  it("bundles the chart's current proxy and digest-pinned data images", () => {
    const images = pkg.components.find((c) => c.name === "optio").images;
    for (const config of [
      chart.agent.envoyProxy.image,
      chart.postgresql.image,
      chart.redis.image,
    ]) {
      assert.ok(
        images.includes(
          `docker.io/${config.repository.includes("/") ? "" : "library/"}${config.repository}:${config.tag}`,
        ),
      );
    }
    const values = parse(packageValues());
    assert.equal(values.agent.envoyProxy, undefined);
    assert.equal(values.postgresql.image, undefined);
    assert.equal(values.redis, undefined);
  });
  it("declares substitutions and keeps Optio tags at the package version", () => {
    const text =
      read("deploy/zarf/values/optio.yaml") +
      read("deploy/zarf/manifests/metrics-server-v0.9.0.yaml");
    for (const [, name] of text.matchAll(/###ZARF_VAR_(\w+)###/g)) assert.ok(variables[name], name);
    for (const name of ["ENCRYPTION_KEY", "POSTGRES_PASSWORD", "OIDC_CLIENT_SECRET"]) {
      assert.equal(variables[name].sensitive, true);
    }
    for (const component of pkg.components) {
      for (const image of component.images ?? []) {
        if (image.startsWith("optio.local/"))
          assert.ok(image.endsWith(`:${pkg.metadata.version}`), image);
      }
    }
    const values = parse(packageValues());
    for (const name of ["api", "web", "agent"])
      assert.equal(values[name].image.tag, pkg.metadata.version);
    assert.equal(values.createNamespace, false);
    for (const file of ["docs/examples/ci/github-actions.yml", "docs/examples/ci/gitlab-ci.yml"])
      parse(read(file));
  });
});

const helmAvailable = spawnSync("helm", ["version", "--short"]).status === 0;
describe("deployment chart rendering", { skip: !helmAvailable }, () => {
  const args = [
    "template",
    "optio",
    join(root, "helm/optio"),
    "--kube-version",
    "1.33.0",
    "--set",
    "publicUrl=https://optio.example.com",
    "--set",
    `encryption.key=${"a".repeat(64)}`,
    "--set",
    "postgresql.auth.password=render-only",
    "--set",
    "postgresql.tls.enabled=false",
    "--set",
    "redis.tls.enabled=false",
    "--set",
    "redis.auth.password=render-only",
  ];
  const render = (...extra) => {
    const result = spawnSync("helm", [...args, ...extra], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout
      .split(/^---\s*$/m)
      .map((text) => parse(text))
      .filter(Boolean);
  };
  it("changes only the Namespace object when namespace creation is disabled", () => {
    const normal = render();
    assert.equal(normal.filter((object) => object.kind === "Namespace").length, 1);
    assert.deepEqual(
      render("--set", "createNamespace=false"),
      normal.filter((object) => object.kind !== "Namespace"),
    );
  });
  it("omits ingress TLS without a secret and preserves a named secret", () => {
    const extra = ["--set", "ingress.enabled=true", "--set", "ingress.tls[0].secretName="];
    assert.equal(render(...extra).find((o) => o.kind === "Ingress").spec.tls, undefined);
    assert.equal(
      render(...extra, "--set", "ingress.tls[0].secretName=optio-tls").find(
        (o) => o.kind === "Ingress",
      ).spec.tls[0].secretName,
      "optio-tls",
    );
  });
  it("requires TLS for LDAP only when auth.ldap.requireTls is set", () => {
    const config = (...extra) =>
      render(...extra).find((o) => o.kind === "Secret" && o.metadata.name === "optio-config")
        .stringData;
    assert.equal(config().OPTIO_LDAP_REQUIRE_TLS, undefined);
    // Set without auth.ldap.url too: the directory may be configured in the app.
    assert.equal(config("--set", "auth.ldap.requireTls=true").OPTIO_LDAP_REQUIRE_TLS, "true");
  });
  it("renders the previous encryption key only while rotating, and always as a key", () => {
    const config = (...extra) =>
      render(...extra).find((o) => o.kind === "Secret" && o.metadata.name === "optio-config")
        .stringData;
    // Empty, not absent: a key dropped from stringData would linger in the Secret.
    assert.equal(config().OPTIO_ENCRYPTION_KEY_PREVIOUS, "");
    const old = "b".repeat(64);
    assert.equal(
      config("--set", `encryption.previousKey=${old}`).OPTIO_ENCRYPTION_KEY_PREVIOUS,
      old,
    );
    const external = config(
      "--set",
      "existingSecrets.OPTIO_ENCRYPTION_KEY_PREVIOUS.name=optio-runtime",
      "--set",
      "existingSecrets.OPTIO_ENCRYPTION_KEY_PREVIOUS.key=previous-key",
    );
    assert.equal(external.OPTIO_ENCRYPTION_KEY_PREVIOUS, undefined);
  });
  it("renders the substituted package without creating a Namespace", () => {
    const file = join(temp(), "values.yaml");
    writeFileSync(file, packageValues());
    const objects = render("--values", file);
    assert.ok(!objects.some((object) => object.kind === "Namespace"));
    const api = objects.find(
      (object) => object.kind === "Deployment" && object.metadata.name === "optio-api",
    );
    assert.equal(api.spec.template.spec.containers[0].image, "optio.local/optio-api:0.1.0");
  });
});

describe("CI helpers", () => {
  it("passes explicit arguments and contexts to a builder without calling a daemon", () => {
    const dir = temp();
    const log = join(dir, "calls");
    const docker = join(dir, "docker");
    writeFileSync(
      docker,
      `#!/bin/sh
[ "$1 $2" = 'buildx version' ] && exit 0
printf '%s\\n' "$@" > "$LOG"
while [ $# -gt 0 ]; do
  if [ "$1" = --metadata-file ]; then shift; printf '{}' > "$1"; fi
  shift
done
`,
    );
    chmodSync(docker, 0o755);
    const result = spawnSync(
      "sh",
      [
        join(root, "docs/examples/ci/build-image.sh"),
        "optio-web",
        "Dockerfile.web",
        "--arg",
        "PNPM_OFFLINE=1",
        "--context",
        "pnpm-offline=/transferred/store",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          LOG: log,
          OPTIO_REGISTRY: "registry.example.com/optio",
          OPTIO_IMAGE_TAGS: "test",
          OPTIO_BUILD_NETWORK: "none",
          OPTIO_BUILD_OUT: dir,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(log, "utf8");
    assert.match(calls, /--network\nnone/);
    assert.match(calls, /--build-arg\nPNPM_OFFLINE=1/);
    assert.match(calls, /--build-context\npnpm-offline=\/transferred\/store/);
  });
  it("smoke checks the existing health, sign-in, setup and public endpoints", async () => {
    const server = createServer((req, res) => {
      const responses = {
        "/api/health": { healthy: true },
        "/api/auth/providers": { providers: [{ name: "oidc" }] },
        "/api/setup/status": { isSetUp: true },
        "/": "Optio",
      };
      res.statusCode = req.url in responses ? 200 : 404;
      res.end(JSON.stringify(responses[req.url] ?? { error: "not found" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(
          "bash",
          [
            join(root, "docs/examples/ci/smoke.sh"),
            `http://127.0.0.1:${server.address().port}`,
            "--providers",
            "oidc",
            "--timeout",
            "1",
          ],
          { cwd: root, env: { ...process.env, OPTIO_CA_FILE: "" } },
        );
        let output = "";
        child.stdout.on("data", (data) => {
          output += data;
        });
        child.stderr.on("data", (data) => {
          output += data;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, output }));
      });
      assert.equal(result.code, 0, result.output);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
