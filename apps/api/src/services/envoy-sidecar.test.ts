import { describe, it, expect } from "vitest";
import {
  generateEnvoyConfig,
  generateSecretInitScript,
  buildEnvoySidecarContainer,
  buildSecretInitContainer,
  buildEnvoyVolumes,
  getAgentProxyEnv,
  getAgentCaVolumeMount,
  PROXIED_SECRET_ENV_VARS,
  ENVOY_PROXY_PORT,
} from "./envoy-sidecar.js";

// ── generateEnvoyConfig ──────────────────────────────────────────────

describe("generateEnvoyConfig", () => {
  it("generates config with GitHub token routes", () => {
    const config = generateEnvoyConfig({ githubToken: "ghp_test123" });

    expect(config).toContain("proxy_listener");
    expect(config).toContain(`port_value: ${ENVOY_PROXY_PORT}`);
    expect(config).toContain("api.github.com");
    expect(config).toContain("github.com");
    expect(config).toContain("Authorization");
    expect(config).toContain("Bearer");
    expect(config).toContain("cluster: github");
    expect(config).toContain("cluster: github_main");
    // Should not contain Anthropic config
    expect(config).not.toContain("api.anthropic.com");
    expect(config).not.toContain("x-api-key");
  });

  it("generates config with Anthropic API key routes", () => {
    const config = generateEnvoyConfig({ anthropicApiKey: "sk-ant-test" });

    expect(config).toContain("api.anthropic.com");
    expect(config).toContain("x-api-key");
    expect(config).toContain("cluster: anthropic");
    // Should not contain GitHub config
    expect(config).not.toContain("api.github.com");
    expect(config).not.toContain("Authorization");
  });

  it("generates config with both secrets", () => {
    const config = generateEnvoyConfig({
      githubToken: "ghp_test123",
      anthropicApiKey: "sk-ant-test",
    });

    expect(config).toContain("api.github.com");
    expect(config).toContain("api.anthropic.com");
    expect(config).toContain("cluster: github");
    expect(config).toContain("cluster: anthropic");
  });

  it("generates minimal config with no secrets", () => {
    const config = generateEnvoyConfig({});

    expect(config).toContain("proxy_listener");
    expect(config).toContain("passthrough");
    expect(config).not.toContain("api.github.com");
    expect(config).not.toContain("api.anthropic.com");
  });

  it("includes passthrough cluster for unmatched hosts", () => {
    const config = generateEnvoyConfig({ githubToken: "ghp_test" });

    expect(config).toContain("cluster: passthrough");
    expect(config).toContain("ORIGINAL_DST");
  });

  it("includes admin interface on localhost", () => {
    const config = generateEnvoyConfig({});

    expect(config).toContain("admin:");
    expect(config).toContain("port_value: 10001");
  });
});

// ── generateSecretInitScript ─────────────────────────────────────────

describe("generateSecretInitScript", () => {
  it("writes GitHub token to file when provided", () => {
    const script = generateSecretInitScript({ githubToken: "ghp_test" });

    expect(script).toContain("GITHUB_TOKEN");
    expect(script).toContain("github-token");
    expect(script).toContain("chmod 600");
  });

  it("writes Anthropic API key to file when provided", () => {
    const script = generateSecretInitScript({ anthropicApiKey: "sk-ant-test" });

    expect(script).toContain("ANTHROPIC_API_KEY");
    expect(script).toContain("anthropic-api-key");
  });

  it("generates CA certificate", () => {
    const script = generateSecretInitScript({});

    expect(script).toContain("openssl req -x509");
    expect(script).toContain("Optio Envoy Proxy CA");
    expect(script).toContain("ca.crt");
    expect(script).toContain("ca.key");
  });

  it("handles both secrets", () => {
    const script = generateSecretInitScript({
      githubToken: "ghp_test",
      anthropicApiKey: "sk-ant-test",
    });

    expect(script).toContain("github-token");
    expect(script).toContain("anthropic-api-key");
  });
});

// ── buildEnvoySidecarContainer ───────────────────────────────────────

describe("buildEnvoySidecarContainer", () => {
  it("creates container with correct image", () => {
    const container = buildEnvoySidecarContainer({
      envoyImage: "envoyproxy/envoy:v1.31-latest",
    });

    expect(container.name).toBe("envoy-proxy");
    expect(container.image).toBe("envoyproxy/envoy:v1.31-latest");
  });

  it("sets envoy command with config path", () => {
    const container = buildEnvoySidecarContainer({
      envoyImage: "envoyproxy/envoy:v1.31-latest",
    });

    expect(container.command).toContain("envoy");
    expect(container.command).toContain("-c");
    expect(container.command).toContain("/etc/envoy/envoy.yaml");
  });

  it("includes volume mounts for config, secrets, and CA", () => {
    const container = buildEnvoySidecarContainer({
      envoyImage: "envoyproxy/envoy:v1.31-latest",
    });

    const mountNames = container.volumeMounts!.map((m: any) => m.name);
    expect(mountNames).toContain("envoy-config");
    expect(mountNames).toContain("envoy-secrets");
    expect(mountNames).toContain("envoy-ca");
  });

  it("sets resource limits", () => {
    const container = buildEnvoySidecarContainer({
      envoyImage: "envoyproxy/envoy:v1.31-latest",
    });

    expect(container.resources?.requests?.cpu).toBe("50m");
    expect(container.resources?.limits?.memory).toBe("128Mi");
  });

  it("uses provided imagePullPolicy", () => {
    const container = buildEnvoySidecarContainer({
      envoyImage: "envoyproxy/envoy:v1.31-latest",
      imagePullPolicy: "Always",
    });

    expect(container.imagePullPolicy).toBe("Always");
  });
});

// ── buildSecretInitContainer ─────────────────────────────────────────

describe("buildSecretInitContainer", () => {
  it("creates init container with correct name", () => {
    const container = buildSecretInitContainer({
      envoyImage: "envoyproxy/envoy:v1.31-latest",
      secrets: { githubToken: "ghp_test" },
    });

    expect(container.name).toBe("secret-init");
  });

  it("passes GitHub token as env var", () => {
    const container = buildSecretInitContainer({
      envoyImage: "envoyproxy/envoy:v1.31-latest",
      secrets: { githubToken: "ghp_test123" },
    });

    const envNames = container.env!.map((e: any) => e.name);
    expect(envNames).toContain("GITHUB_TOKEN");
  });

  it("passes Anthropic API key as env var", () => {
    const container = buildSecretInitContainer({
      envoyImage: "envoyproxy/envoy:v1.31-latest",
      secrets: { anthropicApiKey: "sk-ant-test" },
    });

    const envNames = container.env!.map((e: any) => e.name);
    expect(envNames).toContain("ANTHROPIC_API_KEY");
  });

  it("does not include env vars for missing secrets", () => {
    const container = buildSecretInitContainer({
      envoyImage: "envoyproxy/envoy:v1.31-latest",
      secrets: {},
    });

    expect(container.env).toEqual([]);
  });
});

// ── buildEnvoyVolumes ────────────────────────────────────────────────

describe("buildEnvoyVolumes", () => {
  it("returns three volumes", () => {
    const volumes = buildEnvoyVolumes("dummy config");

    expect(volumes).toHaveLength(3);
    const names = volumes.map((v) => v.name);
    expect(names).toContain("envoy-config");
    expect(names).toContain("envoy-secrets");
    expect(names).toContain("envoy-ca");
  });

  it("uses Memory medium for secret volumes", () => {
    const volumes = buildEnvoyVolumes("dummy config");

    const secretsVol = volumes.find((v) => v.name === "envoy-secrets") as any;
    expect(secretsVol.emptyDir.medium).toBe("Memory");

    const caVol = volumes.find((v) => v.name === "envoy-ca") as any;
    expect(caVol.emptyDir.medium).toBe("Memory");
  });
});

// ── getAgentProxyEnv ─────────────────────────────────────────────────

describe("getAgentProxyEnv", () => {
  it("returns proxy env vars pointing to localhost", () => {
    const env = getAgentProxyEnv();

    expect(env.HTTP_PROXY).toBe(`http://127.0.0.1:${ENVOY_PROXY_PORT}`);
    expect(env.HTTPS_PROXY).toBe(`http://127.0.0.1:${ENVOY_PROXY_PORT}`);
    expect(env.http_proxy).toBe(`http://127.0.0.1:${ENVOY_PROXY_PORT}`);
    expect(env.https_proxy).toBe(`http://127.0.0.1:${ENVOY_PROXY_PORT}`);
  });

  it("includes NO_PROXY for localhost and cluster traffic", () => {
    const env = getAgentProxyEnv();

    expect(env.NO_PROXY).toContain("localhost");
    expect(env.NO_PROXY).toContain("127.0.0.1");
    expect(env.no_proxy).toContain("*.svc.cluster.local");
  });
});

// ── getAgentCaVolumeMount ────────────────────────────────────────────

describe("getAgentCaVolumeMount", () => {
  it("mounts CA cert to system trust store", () => {
    const mount = getAgentCaVolumeMount();

    expect(mount.name).toBe("envoy-ca");
    expect(mount.mountPath).toContain("ca-certificates");
    expect(mount.readOnly).toBe(true);
    expect(mount.subPath).toBe("ca.crt");
  });
});

// ── PROXIED_SECRET_ENV_VARS ──────────────────────────────────────────

describe("PROXIED_SECRET_ENV_VARS", () => {
  it("lists the expected secret env var names", () => {
    expect(PROXIED_SECRET_ENV_VARS).toContain("GITHUB_TOKEN");
    expect(PROXIED_SECRET_ENV_VARS).toContain("ANTHROPIC_API_KEY");
    expect(PROXIED_SECRET_ENV_VARS).toHaveLength(2);
  });
});
