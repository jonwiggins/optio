// The chart's agent policy values (docs/agent-policy.md): the egress
// allowlist NetworkPolicy, its validation, the RuntimeClass and the env the
// API reads. Unset, every render is the chart's existing output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../apps/cli/package.json", import.meta.url));
const { parse } = require("yaml");

const helmAvailable = spawnSync("helm", ["version", "--short"]).status === 0;
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
const run = (...extra) => spawnSync("helm", [...args, ...extra], { encoding: "utf8" });
const render = (...extra) => {
  const result = run(...extra);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split(/^---\s*$/m)
    .map((text) => parse(text))
    .filter(Boolean);
};
const policy = (objects) =>
  objects.find((o) => o.kind === "NetworkPolicy" && o.metadata.name === "optio-repo-pod-policy");
const config = (objects) =>
  objects.find((o) => o.kind === "Secret" && o.metadata.name === "optio-config").stringData;
const refused = (...extra) => {
  const result = run(...extra);
  assert.notEqual(result.status, 0, "the render should fail");
  return result.stderr;
};

describe("agent policy chart values", { skip: !helmAvailable }, () => {
  it("sets nothing by default", () => {
    const env = config(render("--set", "networkPolicy.enabled=true"));
    for (const name of [
      "OPTIO_AGENT_POLICY_DEFAULTS",
      "OPTIO_AGENT_RUNTIME_CLASS",
      "OPTIO_AGENT_EGRESS",
    ]) {
      assert.equal(env[name], undefined, name);
    }
    const ports = policy(render("--set", "networkPolicy.enabled=true")).spec.egress.flatMap((r) =>
      r.ports.map((p) => p.port),
    );
    assert.ok(ports.includes(443) && ports.includes(80));
  });

  it("replaces public 443/80 with the allowlist, keeping DNS and the API", () => {
    const objects = render(
      "--set",
      "networkPolicy.enabled=true",
      "--set",
      "networkPolicy.agentEgress[0].name=GitLab",
      "--set",
      "networkPolicy.agentEgress[0].cidr=10.20.0.15/32",
      "--set",
      "networkPolicy.agentEgress[0].ports={443,22}",
      "--set",
      "networkPolicy.agentEgress[1].namespace=ingress-nginx",
    );
    const egress = policy(objects).spec.egress;
    assert.deepEqual(
      egress.map((r) => r.ports.map((p) => p.port)),
      [[53, 53], [4000], [443, 22], [443]],
    );
    assert.equal(egress[2].to[0].ipBlock.cidr, "10.20.0.15/32");
    assert.ok(!JSON.stringify(egress).includes("0.0.0.0/0"));
    assert.deepEqual(JSON.parse(config(objects).OPTIO_AGENT_EGRESS)[0], {
      name: "GitLab",
      cidr: "10.20.0.15/32",
      ports: [443, 22],
    });
  });

  it("refuses entries that would allow too much or can't be enforced", () => {
    const on = ["--set", "networkPolicy.enabled=true"];
    assert.match(
      refused(...on, "--set", "networkPolicy.agentEgress[0].name=x"),
      /needs cidr, cidrs or namespace/,
    );
    assert.match(
      refused(...on, "--set", "networkPolicy.agentEgress[0].cidr=0.0.0.0/0"),
      /isn't a CIDR/,
    );
    assert.match(
      refused(...on, "--set", "networkPolicy.agentEgress[0].host=gitlab.example.com"),
      /not host names/,
    );
    assert.match(
      refused(
        ...on,
        "--set",
        "networkPolicy.agentEgress[0].cidr=10.0.0.1/32",
        "--set",
        "networkPolicy.agentEgress[0].ports={70000}",
      ),
      /isn't a port/,
    );
    assert.match(
      refused("--set", "networkPolicy.agentEgress[0].cidr=10.0.0.1/32"),
      /needs networkPolicy.enabled/,
    );
  });

  it("passes the RuntimeClass and the built-in rules to the API, and checks the name", () => {
    const env = config(
      render("--set", "agent.runtimeClassName=gvisor", "--set", "agentPolicy.builtInRules=true"),
    );
    assert.equal(env.OPTIO_AGENT_RUNTIME_CLASS, "gvisor");
    assert.equal(env.OPTIO_AGENT_POLICY_DEFAULTS, "true");
    assert.match(refused("--set", "agent.runtimeClassName=Not_A_Class"), /RuntimeClass name/);
  });
});
