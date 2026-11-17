import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { ContainerSpec } from "@optio/shared";
import { DIND_ENTRYPOINT, DIND_POD_COMMAND, DIND_PRE_STOP, dindPodFields } from "./dind-pod.js";
import { K8sWorkloadManager } from "./k8s-workload-service.js";

function buildTemplate(spec: ContainerSpec) {
  const manager = Object.create(K8sWorkloadManager.prototype) as {
    buildPodTemplate: (spec: ContainerSpec, name: string, policy: "Always" | "Never") => unknown;
  };
  return manager.buildPodTemplate(spec, "repo-abc", "Always") as any;
}

function baseSpec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    image: "optio-agent:latest",
    command: ["/opt/optio/repo-init.sh"],
    env: {},
    workDir: "/workspace",
    labels: { "optio.type": "repo-pod" },
    ...overrides,
  };
}

describe("dind-pod", () => {
  it("starts through the dind entrypoint and falls back to repo-init.sh", () => {
    expect(DIND_POD_COMMAND.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    const script = DIND_POD_COMMAND[2];
    expect(script).toContain(`[ -x ${DIND_ENTRYPOINT} ]`);
    expect(script).toContain(`exec ${DIND_ENTRYPOINT}`);
    expect(script).toContain("exec /opt/optio/repo-init.sh");
  });

  it("stops the run's containers and dockerd (by its pidfile) before the pod stops", () => {
    const script = DIND_PRE_STOP[2];
    expect(script).toContain("docker ps -q | xargs -r docker rm -f");
    expect(script).toContain("/var/run/docker.pid");
    expect(script).toContain('kill -TERM "$pid"');
    // The hook never fails: a failed preStop only delays the pod's stop.
    expect(script.endsWith("true")).toBe(true);
  });

  it("produces shell scripts that parse", () => {
    for (const cmd of [DIND_POD_COMMAND, DIND_PRE_STOP]) {
      expect(() => execFileSync("/bin/sh", ["-n", "-c", cmd[2]])).not.toThrow();
    }
  });

  it("returns fresh copies, so a caller cannot change the shared constants", () => {
    const fields = dindPodFields();
    fields.command.push("x");
    fields.preStop.push("y");
    expect(dindPodFields()).toEqual({ command: DIND_POD_COMMAND, preStop: DIND_PRE_STOP });
  });
});

describe("K8sWorkloadManager preStop (StatefulSet repo pods)", () => {
  it("adds lifecycle.preStop.exec and the entrypoint command for a DinD spec", () => {
    const container = buildTemplate(baseSpec(dindPodFields())).spec.containers[0];
    expect(container.command).toEqual(DIND_POD_COMMAND);
    expect(container.lifecycle).toEqual({ preStop: { exec: { command: DIND_PRE_STOP } } });
  });

  it("leaves lifecycle unset without a preStop", () => {
    const container = buildTemplate(baseSpec()).spec.containers[0];
    expect(container.command).toEqual(["/opt/optio/repo-init.sh"]);
    expect(container.lifecycle).toBeUndefined();
    expect(buildTemplate(baseSpec({ preStop: [] })).spec.containers[0].lifecycle).toBeUndefined();
  });
});
