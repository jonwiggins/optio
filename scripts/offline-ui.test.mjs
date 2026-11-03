import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// The offline web UI (chart web.offline -> OPTIO_OFFLINE_UI on the web
// container; apps/web/src/lib/offline-ui.ts): off in the chart, on in the
// Zarf package and the Rancher form.
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../apps/cli/package.json", import.meta.url));
const { parse } = require("yaml");
const read = (file) => readFileSync(join(root, file), "utf8");

describe("offline web UI settings", () => {
  it("is off in the chart and on in the Zarf package and the Rancher form", () => {
    assert.equal(parse(read("helm/optio/values.yaml")).web.offline, false);
    assert.equal(parse(read("deploy/zarf/values/optio.yaml")).web.offline, true);
    const question = parse(read("helm/optio/questions.yaml")).questions.find(
      (q) => q.variable === "web.offline",
    );
    assert.equal(question?.type, "boolean");
    assert.equal(question?.default, true);
  });
});

const helmAvailable = spawnSync("helm", ["version", "--short"]).status === 0;
describe("offline web UI rendering", { skip: !helmAvailable }, () => {
  const webEnv = (...extra) => {
    const result = spawnSync(
      "helm",
      [
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
        "redis.auth.password=render-only",
        ...extra,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const api = result.stdout
      .split(/^---\s*$/m)
      .map((text) => parse(text))
      .find((o) => o?.kind === "Deployment" && o.metadata.name === "optio-api");
    const containers = api.spec.template.spec.containers;
    const env = (name) => containers.find((c) => c.name === name).env ?? [];
    return { web: env("web"), api: env(containers[0].name) };
  };

  it("sets nothing by default", () => {
    const { web } = webEnv();
    assert.equal(
      web.find((e) => e.name === "OPTIO_OFFLINE_UI"),
      undefined,
    );
  });

  it("sets OPTIO_OFFLINE_UI=true on the web container only when on", () => {
    const { web, api } = webEnv("--set", "web.offline=true");
    assert.deepEqual(
      web.find((e) => e.name === "OPTIO_OFFLINE_UI"),
      { name: "OPTIO_OFFLINE_UI", value: "true" },
    );
    assert.equal(
      api.find((e) => e.name === "OPTIO_OFFLINE_UI"),
      undefined,
    );
  });
});
