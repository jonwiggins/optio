import { isIP } from "node:net";

/** Keep public destinations aligned with helm/optio/templates/network-policy.yaml. */
export const PUBLIC_NETWORK_PEERS = [
  {
    ipBlock: {
      cidr: "0.0.0.0/0",
      except: [
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "224.0.0.0/4",
        "240.0.0.0/4",
      ],
    },
  },
  {
    ipBlock: {
      cidr: "::/0",
      except: [
        "::/128",
        "::1/128",
        "::ffff:0:0/96",
        "64:ff9b::/96",
        "100::/64",
        "fc00::/7",
        "fe80::/10",
        "fec0::/10",
        "ff00::/8",
      ],
    },
  },
];

/**
 * A restricted repo's policy must not grant namespace-wide access: policies add permissions.
 * For the same reason, with the chart's agent egress allowlist on
 * (`publicHttps: false`, docs/agent-policy.md) it adds no public HTTPS rule
 * of its own, which would reopen what the allowlist closed.
 */
export function restrictedAgentNetworkPolicy(
  podName: string,
  namespace: string,
  apiPort: number,
  additionalDeniedCidrs: unknown = [],
  opts: { publicHttps?: boolean } = {},
) {
  const publicPeers = PUBLIC_NETWORK_PEERS.map(({ ipBlock }) => ({
    ipBlock: { ...ipBlock, except: [...ipBlock.except] },
  }));
  if (!Array.isArray(additionalDeniedCidrs)) throw new Error("Invalid agent denied egress CIDRs");
  for (const cidr of additionalDeniedCidrs) {
    const parts = typeof cidr === "string" ? cidr.split("/") : [];
    const family = parts[0] ? isIP(parts[0]) : 0;
    if (
      parts.length !== 2 ||
      !family ||
      !/^\d+$/.test(parts[1]) ||
      Number(parts[1]) > (family === 4 ? 32 : 128)
    )
      throw new Error("Invalid agent denied egress CIDR");
    const exceptions = publicPeers[family === 4 ? 0 : 1].ipBlock.except;
    if (!exceptions.includes(cidr)) exceptions.push(cidr);
  }
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: `optio-egress-${podName}`,
      namespace,
      labels: { "managed-by": "optio", "optio.type": "egress-policy", "optio.pod-name": podName },
    },
    spec: {
      podSelector: {
        matchLabels: { "optio.type": "repo-pod", "optio.network-policy": "restricted" },
      },
      policyTypes: ["Egress"],
      egress: [
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            },
          ],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
        ...(opts.publicHttps === false
          ? []
          : [{ to: publicPeers, ports: [{ protocol: "TCP", port: 443 }] }]),
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": namespace } },
              podSelector: { matchLabels: { app: "optio-api" } },
            },
          ],
          ports: [{ protocol: "TCP", port: apiPort }],
        },
      ],
    },
  };
}
