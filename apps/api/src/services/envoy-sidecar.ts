/**
 * Envoy sidecar configuration for secret isolation in agent pods.
 *
 * The sidecar acts as an HTTP forward proxy on localhost. The agent container
 * has HTTP_PROXY / HTTPS_PROXY pointed at the sidecar. Envoy intercepts
 * outbound requests and injects authentication headers (GitHub token,
 * Anthropic API key) so the agent never sees raw credentials.
 *
 * Token files are mounted from a shared tmpfs volume that only the sidecar
 * container can read.
 */

import type { V1Container, V1Volume, V1VolumeMount, V1EnvVar } from "@kubernetes/client-node";

/** Envoy listener port inside the pod (localhost only). */
export const ENVOY_PROXY_PORT = 10080;

/** Path prefix for secret token files inside the sidecar container. */
const SECRET_MOUNT_PATH = "/etc/envoy/secrets";

/** Path for the Envoy configuration file. */
const ENVOY_CONFIG_PATH = "/etc/envoy/envoy.yaml";

/** Path for the CA certificate (shared with agent container). */
export const CA_CERT_PATH = "/etc/envoy/ca/ca.crt";
export const CA_KEY_PATH = "/etc/envoy/ca/ca.key";

export interface SecretProxySecrets {
  githubToken?: string;
  anthropicApiKey?: string;
}

/**
 * Generate the Envoy configuration YAML for credential injection.
 *
 * Envoy is configured as an HTTP forward proxy (using the CONNECT method for
 * HTTPS). For matched upstream hosts it injects the appropriate auth headers.
 */
export function generateEnvoyConfig(secrets: SecretProxySecrets): string {
  const clusters: string[] = [];
  const routes: string[] = [];

  if (secrets.githubToken) {
    clusters.push(`
    - name: github
      type: STRICT_DNS
      dns_lookup_family: V4_ONLY
      load_assignment:
        cluster_name: github
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: api.github.com
                      port_value: 443
      transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext
          sni: api.github.com
    - name: github_main
      type: STRICT_DNS
      dns_lookup_family: V4_ONLY
      load_assignment:
        cluster_name: github_main
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: github.com
                      port_value: 443
      transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext
          sni: github.com`);

    routes.push(`
              - match:
                  connect_matcher: {}
                  headers:
                    - name: ":authority"
                      string_match:
                        contains: "api.github.com"
                route:
                  cluster: github
                  upgrade_configs:
                    - upgrade_type: CONNECT
                      connect_config: {}
                typed_per_filter_config:
                  envoy.filters.http.credential_injector:
                    "@type": type.googleapis.com/envoy.extensions.filters.http.credential_injector.v3.CredentialInjector
                    overwrite: false
                    credential:
                      name: envoy.http.injected_credentials.generic
                      typed_config:
                        "@type": type.googleapis.com/envoy.extensions.http.injected_credentials.generic.v3.Generic
                        credential:
                          name: github-token
                          sds_config:
                            path: /dev/null
                        header: "Authorization"
                        value_prefix: "Bearer "`);

    routes.push(`
              - match:
                  connect_matcher: {}
                  headers:
                    - name: ":authority"
                      string_match:
                        contains: "github.com"
                route:
                  cluster: github_main
                  upgrade_configs:
                    - upgrade_type: CONNECT
                      connect_config: {}
                typed_per_filter_config:
                  envoy.filters.http.credential_injector:
                    "@type": type.googleapis.com/envoy.extensions.filters.http.credential_injector.v3.CredentialInjector
                    overwrite: false
                    credential:
                      name: envoy.http.injected_credentials.generic
                      typed_config:
                        "@type": type.googleapis.com/envoy.extensions.http.injected_credentials.generic.v3.Generic
                        credential:
                          name: github-token
                          sds_config:
                            path: /dev/null
                        header: "Authorization"
                        value_prefix: "Bearer "`);
  }

  if (secrets.anthropicApiKey) {
    clusters.push(`
    - name: anthropic
      type: STRICT_DNS
      dns_lookup_family: V4_ONLY
      load_assignment:
        cluster_name: anthropic
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: api.anthropic.com
                      port_value: 443
      transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext
          sni: api.anthropic.com`);

    routes.push(`
              - match:
                  connect_matcher: {}
                  headers:
                    - name: ":authority"
                      string_match:
                        contains: "api.anthropic.com"
                route:
                  cluster: anthropic
                  upgrade_configs:
                    - upgrade_type: CONNECT
                      connect_config: {}
                typed_per_filter_config:
                  envoy.filters.http.credential_injector:
                    "@type": type.googleapis.com/envoy.extensions.filters.http.credential_injector.v3.CredentialInjector
                    overwrite: false
                    credential:
                      name: envoy.http.injected_credentials.generic
                      typed_config:
                        "@type": type.googleapis.com/envoy.extensions.http.injected_credentials.generic.v3.Generic
                        credential:
                          name: anthropic-key
                          sds_config:
                            path: /dev/null
                        header: "x-api-key"`);
  }

  return `# Auto-generated Envoy sidecar config for Optio secret proxy
static_resources:
  listeners:
    - name: proxy_listener
      address:
        socket_address:
          address: 127.0.0.1
          port_value: ${ENVOY_PROXY_PORT}
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: ingress_http
                codec_type: AUTO
                http_protocol_options:
                  allow_absolute_url: true
                upgrade_configs:
                  - upgrade_type: CONNECT
                route_config:
                  name: local_route
                  virtual_hosts:
                    - name: forward_proxy
                      domains: ["*"]
                      routes:${routes.join("")}
                        - match:
                            connect_matcher: {}
                          route:
                            cluster: passthrough
                            upgrade_configs:
                              - upgrade_type: CONNECT
                                connect_config: {}
                        - match:
                            prefix: "/"
                          route:
                            cluster: passthrough
                http_filters:
                  - name: envoy.filters.http.credential_injector
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.credential_injector.v3.CredentialInjector
                      overwrite: false
                      credential:
                        name: envoy.http.injected_credentials.generic
                        typed_config:
                          "@type": type.googleapis.com/envoy.extensions.http.injected_credentials.generic.v3.Generic
                          credential:
                            name: noop
                            sds_config:
                              path: /dev/null
                          header: "x-optio-proxy"
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router

  clusters:${clusters.join("")}
    - name: passthrough
      type: ORIGINAL_DST
      lb_policy: CLUSTER_PROVIDED
      original_dst_lb_config:
        use_http_header: true

admin:
  address:
    socket_address:
      address: 127.0.0.1
      port_value: 10001
`;
}

/**
 * Generate the init script that writes secret token files.
 * Runs as an init container before the sidecar starts.
 */
export function generateSecretInitScript(secrets: SecretProxySecrets): string {
  const lines = ["#!/bin/sh", "set -e", `mkdir -p ${SECRET_MOUNT_PATH}`];

  if (secrets.githubToken) {
    lines.push(`printf '%s' "$GITHUB_TOKEN" > ${SECRET_MOUNT_PATH}/github-token`);
    lines.push(`chmod 600 ${SECRET_MOUNT_PATH}/github-token`);
  }

  if (secrets.anthropicApiKey) {
    lines.push(`printf '%s' "$ANTHROPIC_API_KEY" > ${SECRET_MOUNT_PATH}/anthropic-api-key`);
    lines.push(`chmod 600 ${SECRET_MOUNT_PATH}/anthropic-api-key`);
  }

  // Generate a self-signed CA certificate for TLS interception
  lines.push(`mkdir -p /etc/envoy/ca`);
  lines.push(
    `openssl req -x509 -newkey rsa:2048 -keyout ${CA_KEY_PATH} -out ${CA_CERT_PATH} ` +
      `-days 365 -nodes -subj "/CN=Optio Envoy Proxy CA" 2>/dev/null`,
  );

  lines.push(`echo "[optio] Secret proxy init complete"`);
  return lines.join("\n");
}

/**
 * Build the Envoy sidecar container spec for a pod.
 */
export function buildEnvoySidecarContainer(opts: {
  envoyImage: string;
  imagePullPolicy?: string;
}): V1Container {
  const container: V1Container = {
    name: "envoy-proxy",
    image: opts.envoyImage,
    imagePullPolicy: (opts.imagePullPolicy as any) ?? "IfNotPresent",
    command: ["envoy", "-c", ENVOY_CONFIG_PATH, "--log-level", "warn"],
    ports: [{ containerPort: ENVOY_PROXY_PORT, protocol: "TCP" }],
    volumeMounts: [
      { name: "envoy-config", mountPath: "/etc/envoy/envoy.yaml", subPath: "envoy.yaml" },
      { name: "envoy-secrets", mountPath: SECRET_MOUNT_PATH, readOnly: true },
      { name: "envoy-ca", mountPath: "/etc/envoy/ca", readOnly: true },
    ],
    resources: {
      requests: { cpu: "50m", memory: "64Mi" },
      limits: { cpu: "200m", memory: "128Mi" },
    },
  };
  return container;
}

/**
 * Build the init container that writes secrets to the shared tmpfs volume.
 */
export function buildSecretInitContainer(opts: {
  envoyImage: string;
  secrets: SecretProxySecrets;
  imagePullPolicy?: string;
}): V1Container {
  const env: V1EnvVar[] = [];
  if (opts.secrets.githubToken) {
    env.push({ name: "GITHUB_TOKEN", value: opts.secrets.githubToken });
  }
  if (opts.secrets.anthropicApiKey) {
    env.push({ name: "ANTHROPIC_API_KEY", value: opts.secrets.anthropicApiKey });
  }

  const container: V1Container = {
    name: "secret-init",
    image: opts.envoyImage,
    imagePullPolicy: (opts.imagePullPolicy as any) ?? "IfNotPresent",
    command: ["sh", "-c", generateSecretInitScript(opts.secrets)],
    env,
    volumeMounts: [
      { name: "envoy-secrets", mountPath: SECRET_MOUNT_PATH },
      { name: "envoy-ca", mountPath: "/etc/envoy/ca" },
    ],
  };
  return container;
}

/**
 * Build the volumes needed for the Envoy sidecar setup.
 */
export function buildEnvoyVolumes(envoyConfig: string): V1Volume[] {
  return [
    {
      name: "envoy-config",
      configMap: {
        name: "envoy-proxy-config",
        items: [{ key: "envoy.yaml", path: "envoy.yaml" }],
      },
    } as any,
    // tmpfs volume for secret tokens — never written to disk
    {
      name: "envoy-secrets",
      emptyDir: { medium: "Memory", sizeLimit: "1Mi" },
    },
    // tmpfs volume for the generated CA certificate
    {
      name: "envoy-ca",
      emptyDir: { medium: "Memory", sizeLimit: "1Mi" },
    },
  ];
}

/**
 * Get the environment variables that should be set on the agent container
 * to route traffic through the Envoy proxy.
 */
export function getAgentProxyEnv(): Record<string, string> {
  return {
    HTTP_PROXY: `http://127.0.0.1:${ENVOY_PROXY_PORT}`,
    HTTPS_PROXY: `http://127.0.0.1:${ENVOY_PROXY_PORT}`,
    http_proxy: `http://127.0.0.1:${ENVOY_PROXY_PORT}`,
    https_proxy: `http://127.0.0.1:${ENVOY_PROXY_PORT}`,
    // Don't proxy localhost traffic
    NO_PROXY: "localhost,127.0.0.1,*.svc.cluster.local",
    no_proxy: "localhost,127.0.0.1,*.svc.cluster.local",
  };
}

/**
 * Get the volume mount for the agent container to trust the Envoy CA.
 */
export function getAgentCaVolumeMount(): V1VolumeMount {
  return {
    name: "envoy-ca",
    mountPath: "/usr/local/share/ca-certificates/optio-envoy-ca.crt",
    subPath: "ca.crt",
    readOnly: true,
  };
}

/**
 * List of secret env var names that should be stripped from the agent container
 * when secret proxy is enabled (they're only needed in the sidecar).
 */
export const PROXIED_SECRET_ENV_VARS = ["GITHUB_TOKEN", "ANTHROPIC_API_KEY"] as const;
