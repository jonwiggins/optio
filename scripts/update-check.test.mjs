import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// The chart's `updates.check` value and the offline installs that turn it off.

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../apps/cli/package.json", import.meta.url));
const { parse } = require("yaml");
const read = (file) => readFileSync(join(root, file), "utf8");

describe("update check settings", () => {
  it("is on in the chart and off in the offline package and the Rancher form", () => {
    assert.equal(parse(read("helm/optio/values.yaml")).updates.check, true);
    assert.equal(parse(read("deploy/zarf/values/optio.yaml")).updates.check, false);
    const question = parse(read("helm/optio/questions.yaml")).questions.find(
      (q) => q.variable === "updates.check",
    );
    assert.equal(question.type, "boolean");
    assert.equal(question.default, false);
  });
});

const helmAvailable = spawnSync("helm", ["version", "--short"]).status === 0;
describe("update check rendering", { skip: !helmAvailable }, () => {
  const config = (...extra) => {
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
    return result.stdout
      .split(/^---\s*$/m)
      .map((text) => parse(text))
      .find((o) => o?.kind === "Secret" && o.metadata.name === "optio-config").stringData;
  };

  it("leaves the environment unchanged by default", () => {
    assert.equal(config().OPTIO_UPDATE_CHECK, undefined);
  });

  it("passes updates.check=false to the API", () => {
    assert.equal(config("--set", "updates.check=false").OPTIO_UPDATE_CHECK, "false");
  });
});
