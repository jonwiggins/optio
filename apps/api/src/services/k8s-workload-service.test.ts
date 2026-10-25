import { afterEach, describe, expect, it } from "vitest";
import type { ContainerSpec } from "@optio/shared";
import {
  K8sWorkloadManager,
  WORKLOAD_ALLOWED_CAPABILITIES,
  validateWorkloadCapabilities,
} from "./k8s-workload-service.js";

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

function buildTemplate(spec: ContainerSpec, restartPolicy: "Always" | "Never" = "Always") {
  const manager = Object.create(K8sWorkloadManager.prototype) as {
    buildPodTemplate: (
      spec: ContainerSpec,
      instanceName: string,
      restartPolicy: "Always" | "Never",
    ) => unknown;
  };
  return manager.buildPodTemplate(spec, "repo-abc", restartPolicy) as any;
}

describe("K8sWorkloadManager security context", () => {
  it("drops capabilities and disables privilege escalation by default", () => {
    const template = buildTemplate(baseSpec());
    const container = template.spec.containers[0];

    expect(container.securityContext.capabilities).toEqual({ drop: ["ALL"] });
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(container.securityContext.seccompProfile).toEqual({ type: "RuntimeDefault" });
  });

  it("allows only capabilities from the workload allowlist", () => {
    const template = buildTemplate(baseSpec({ capabilities: ["SYS_CHROOT"] }));
    const container = template.spec.containers[0];

    expect(container.securityContext.capabilities).toEqual({
      drop: ["ALL"],
      add: ["SYS_CHROOT"],
    });
  });

  it("rejects disallowed capabilities", () => {
    expect(() => buildTemplate(baseSpec({ capabilities: ["SYS_ADMIN"] }))).toThrow(
      "Disallowed container capabilities requested: SYS_ADMIN",
    );
  });

  it("keeps the workload allowlist aligned with Docker-in-Docker needs", () => {
    expect(WORKLOAD_ALLOWED_CAPABILITIES.has("SYS_CHROOT")).toBe(true);
    expect(WORKLOAD_ALLOWED_CAPABILITIES.has("SYS_ADMIN")).toBe(false);
    expect(() => validateWorkloadCapabilities(["SYS_CHROOT"])).not.toThrow();
  });
});

describe("preStop hook", () => {
  it("renders spec.preStop as the main container's lifecycle.preStop exec", () => {
    const command = ["/bin/sh", "-c", "pkill -TERM dockerd"];
    const container = buildTemplate(baseSpec({ preStop: command })).spec.containers[0];
    expect(container.lifecycle).toEqual({ preStop: { exec: { command } } });
  });

  it("adds no lifecycle without one", () => {
    expect(buildTemplate(baseSpec()).spec.containers[0].lifecycle).toBeUndefined();
  });
});

describe("rootless mode (OPTIO_ROOTLESS, issue #532)", () => {
  afterEach(() => {
    delete process.env.OPTIO_ROOTLESS;
  });

  it("default mode keeps the root chown initContainer on StatefulSet pods", () => {
    const template = buildTemplate(baseSpec(), "Always");

    const initNames = (template.spec.initContainers ?? []).map((c: { name: string }) => c.name);
    expect(initNames).toContain("home-perm-fix");
    expect(template.spec.securityContext.runAsNonRoot).toBeUndefined();
    expect(template.spec.securityContext.fsGroupChangePolicy).toBeUndefined();
  });

  it("rootless mode omits the initContainer and hardens the pod security context", () => {
    process.env.OPTIO_ROOTLESS = "true";
    const template = buildTemplate(baseSpec(), "Always");

    const initNames = (template.spec.initContainers ?? []).map((c: { name: string }) => c.name);
    expect(initNames).not.toContain("home-perm-fix");
    expect(template.spec.securityContext).toMatchObject({
      fsGroup: 1001,
      runAsUser: 1001,
      runAsGroup: 1001,
      runAsNonRoot: true,
      fsGroupChangePolicy: "OnRootMismatch",
      seccompProfile: { type: "RuntimeDefault" },
    });
    // No root container remains anywhere in the pod
    for (const c of [...(template.spec.initContainers ?? []), ...template.spec.containers]) {
      expect(c.securityContext?.runAsUser).not.toBe(0);
    }
  });

  it("rootless mode still passes caller-supplied initContainers through", () => {
    process.env.OPTIO_ROOTLESS = "true";
    const template = buildTemplate(
      baseSpec({
        initContainers: [{ raw: { name: "custom-init", image: "busybox" } }],
      } as Partial<ContainerSpec>),
      "Always",
    );
    const initNames = (template.spec.initContainers ?? []).map((c: { name: string }) => c.name);
    expect(initNames).toEqual(["custom-init"]);
  });
});

describe("service account token", () => {
  it("never auto-mounts the API token but keeps the ServiceAccount for workload identity", () => {
    const template = buildTemplate(baseSpec({ serviceAccountName: "optio" }));
    expect(template.spec.automountServiceAccountToken).toBe(false);
    expect(template.spec.serviceAccountName).toBe("optio");
  });

  it("disables the automount without a ServiceAccount too", () => {
    const template = buildTemplate(baseSpec(), "Never");
    expect(template.spec.automountServiceAccountToken).toBe(false);
  });
});

describe("the deployment's CA bundle and agent environment (caBundle / agent.env)", () => {
  afterEach(() => {
    delete process.env.OPTIO_AGENT_CA_BUNDLE_CONFIGMAP;
    delete process.env.OPTIO_AGENT_CA_BUNDLE_KEY;
    delete process.env.OPTIO_AGENT_ENV_CONFIGMAP;
  });

  it("adds nothing when neither is configured", () => {
    const template = buildTemplate(baseSpec({ env: { FOO: "bar" } }));
    const container = template.spec.containers[0];

    expect(container.env).toEqual([{ name: "FOO", value: "bar" }]);
    expect(container.envFrom).toBeUndefined();
    const volumeNames = (template.spec.volumes ?? []).map((v: { name: string }) => v.name);
    expect(volumeNames).not.toContain("optio-ca");
    const initNames = (template.spec.initContainers ?? []).map((c: { name: string }) => c.name);
    expect(initNames).not.toContain("ca-bundle");
  });

  it("mounts the merged bundle and points TLS clients at it", () => {
    process.env.OPTIO_AGENT_CA_BUNDLE_CONFIGMAP = "optio-ca-bundle";
    process.env.OPTIO_AGENT_CA_BUNDLE_KEY = "internal.pem";
    const template = buildTemplate(baseSpec(), "Never");
    const container = template.spec.containers[0];
    const env = Object.fromEntries(
      container.env.map((e: { name: string; value: string }) => [e.name, e.value]),
    );

    expect(env.SSL_CERT_FILE).toBe("/etc/optio/ca/bundle.crt");
    expect(env.GIT_SSL_CAINFO).toBe("/etc/optio/ca/bundle.crt");
    expect(env.REQUESTS_CA_BUNDLE).toBe("/etc/optio/ca/bundle.crt");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/optio/ca/internal.crt");
    expect(container.volumeMounts).toContainEqual({
      name: "optio-ca",
      mountPath: "/etc/optio/ca",
      readOnly: true,
    });
    expect(template.spec.volumes).toContainEqual({
      name: "optio-ca-source",
      configMap: { name: "optio-ca-bundle", items: [{ key: "internal.pem", path: "ca.crt" }] },
    });

    const caInit = template.spec.initContainers.find(
      (c: { name: string }) => c.name === "ca-bundle",
    );
    expect(caInit.image).toBe("optio-agent:latest");
    expect(caInit.command.join(" ")).toContain("/etc/ssl/certs/ca-certificates.crt /src/ca.crt");
    // Allowed under the restricted PodSecurity profile.
    expect(caInit.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1001,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    });
  });

  it("keeps the variables Optio sets itself", () => {
    process.env.OPTIO_AGENT_CA_BUNDLE_CONFIGMAP = "optio-ca-bundle";
    const template = buildTemplate(baseSpec({ env: { NODE_EXTRA_CA_CERTS: "/own/ca.crt" } }));
    const values = template.spec.containers[0].env.filter(
      (e: { name: string }) => e.name === "NODE_EXTRA_CA_CERTS",
    );

    expect(values).toEqual([{ name: "NODE_EXTRA_CA_CERTS", value: "/own/ca.crt" }]);
  });

  it("builds the same env twice, so StatefulSet drift checks stay quiet", () => {
    process.env.OPTIO_AGENT_CA_BUNDLE_CONFIGMAP = "optio-ca-bundle";
    const spec = baseSpec({ env: { A: "1" } });

    expect(JSON.stringify(buildTemplate(spec).spec.containers[0].env)).toBe(
      JSON.stringify(buildTemplate(spec).spec.containers[0].env),
    );
  });

  it("loads the agent environment ConfigMap with envFrom", () => {
    process.env.OPTIO_AGENT_ENV_CONFIGMAP = "optio-agent-env";
    const container = buildTemplate(baseSpec()).spec.containers[0];

    expect(container.envFrom).toEqual([
      { configMapRef: { name: "optio-agent-env", optional: true } },
    ]);
  });
});
