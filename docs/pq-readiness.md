# Post-Quantum TLS Readiness

Kubernetes v1.33 (April 2025) is the first release built on Go 1.24. Go 1.24's `crypto/tls` includes `X25519MLKEM768` as a default TLS 1.3 key share when `Config.CurvePreferences` is nil — which Kubernetes does not override. This means on K8s >= 1.33, every Go-based control plane component (API server, kubelet, controllers) negotiates hybrid post-quantum TLS automatically.

Optio pins **Kubernetes >= 1.33** as the minimum supported version (enforced by the Helm chart's `kubeVersion` constraint) so that the Optio API pod's communication with `kube-apiserver` is PQ-hybrid by default.

## PQ status by network leg

| Leg                            | Protocol                                | PQ Status                                    | Notes                                                                                          |
| ------------------------------ | --------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Optio API pod → kube-apiserver | TLS 1.3 (via `@kubernetes/client-node`) | **PQ-hybrid on K8s >= 1.33**                 | Go 1.24 enables X25519MLKEM768 automatically; the Node.js client connects to a Go-based server |
| Web browser → Optio Web UI     | TLS 1.3 (via ingress/load balancer)     | Depends on ingress controller and client     | Configure your ingress controller and TLS termination to support PQ key exchange               |
| Web browser → Optio API        | TLS 1.3 (via ingress/load balancer)     | Depends on ingress controller and client     | Same as above                                                                                  |
| Optio API → PostgreSQL         | TLS (optional, per connection string)   | Not PQ by default                            | Requires PQ-capable PostgreSQL TLS configuration                                               |
| Optio API → Redis              | TLS (optional, per connection string)   | Not PQ by default                            | Requires PQ-capable Redis TLS configuration                                                    |
| Agent pod → GitHub API         | TLS 1.3                                 | Depends on GitHub server support             | GitHub controls server-side TLS negotiation                                                    |
| kubelet → kube-apiserver       | mTLS 1.3                                | **PQ-hybrid on K8s >= 1.33**                 | Both sides are Go 1.24+ binaries                                                               |
| kube-apiserver → etcd          | mTLS 1.3                                | **PQ-hybrid if etcd is built with Go 1.24+** | etcd v3.6+ ships with Go 1.24                                                                  |

## Verification

From inside the Optio API pod on a K8s 1.33+ cluster:

```bash
kubectl exec deploy/optio-api -- node -e '
const https = require("https");
const fs = require("fs");
const req = https.get({
  hostname: "kubernetes.default.svc",
  port: 443,
  path: "/version",
  ca: fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
  headers: { Authorization: "Bearer " + fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8") },
}, (res) => {
  console.log("TLS group:", res.socket.getEphemeralKeyInfo?.()?.name);
  res.on("data", () => {});
});
req.on("error", console.error);
'
# Expected on K8s 1.33+: TLS group: x25519_mlkem768
```

## References

- [Kubernetes Blog: Post-Quantum Cryptography in Kubernetes](https://kubernetes.io/blog/2025/07/18/pqc-in-k8s/)
- [Go 1.24 release notes — crypto/tls](https://go.dev/doc/go1.24#cryptotls)
