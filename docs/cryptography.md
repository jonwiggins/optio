# Cryptography in Optio

This document inventories every cryptographic primitive Optio uses, explains key
management, and describes the post-quantum migration posture. It is the single
reference for procurement security reviews, compliance audits, and engineering
decision-making around cryptographic changes.

---

## 1. Primitive inventory

| Purpose                               | Algorithm                                                          | Key / output size                        | Implementation                                 | PQ-safe?                                             | Migration trigger                                               |
| ------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| Secrets at rest                       | AES-256-GCM (NIST SP 800-38D)                                      | 256-bit key, 96-bit IV, 128-bit auth tag | `node:crypto` via `secret-service.ts`          | Yes (Grover's reduces to 128-bit effective security) | NIST publishes AES successor                                    |
| Session token storage                 | SHA-256 of random 32-byte token                                    | 256-bit hash                             | `session-service.ts`                           | Yes (256-bit pre-image resistance)                   | CNSA 2.0 compliance requirement                                 |
| Internal API auth (pod ↔ API)         | HMAC-SHA256 with replay protection                                 | 256-bit secret                           | `hmac-auth-service.ts`                         | Yes                                                  | None required                                                   |
| Webhook signing (outbound)            | HMAC-SHA256                                                        | Per-webhook secret                       | `webhook-service.ts` via `crypto/signer.ts`    | Yes                                                  | Optional ML-DSA-65 mode when customers demand it                |
| Webhook verification (inbound GitHub) | HMAC-SHA256 + `timingSafeEqual`                                    | GitHub-configured secret                 | `tickets.ts` via `crypto/signer.ts`            | Yes                                                  | Follows GitHub's signing algorithm                              |
| GitHub App JWT                        | RS256 (RSA with SHA-256)                                           | RSA private key (PEM)                    | `github-app-service.ts` via `crypto/signer.ts` | **No** (low HNDL risk; JWT valid 10 min)             | GitHub adds PQ-safe App auth                                    |
| Credential secret derivation          | SHA-256 of `"{key}:credential-secret"`                             | 256-bit derived key                      | `credential-secret-service.ts`                 | Yes                                                  | None required                                                   |
| Envoy sidecar CA                      | Ed25519 self-signed X.509, 30-day validity                         | 256-bit key                              | `envoy-sidecar.ts` via `openssl` CLI           | **No** (ephemeral, intra-pod only)                   | Set `OPTIO_ENVOY_CA_ALG=mldsa44` when OpenSSL 3.5+ is available |
| Postgres TLS (in-cluster)             | Helm-generated self-signed CA, 10-year validity                    | RSA 2048 (Helm `genCA` default)          | `helm/optio/templates/postgres-tls.yaml`       | **No** (cluster-internal)                            | Helm adds PQ CA generation                                      |
| Redis TLS (in-cluster)                | Helm-generated self-signed CA, 10-year validity                    | RSA 2048 (Helm `genCA` default)          | `helm/optio/templates/redis-tls.yaml`          | **No** (cluster-internal)                            | Helm adds PQ CA generation                                      |
| Outbound TLS (fetch to APIs)          | TLS 1.3 via OpenSSL (X25519MLKEM768 hybrid when upstream supports) | Session keys                             | Node.js bundled OpenSSL                        | Yes when upstream supports hybrid                    | Upstream providers ship hybrid TLS                              |
| Kubernetes API TLS                    | Whatever the cluster negotiates                                    | Session keys                             | `@kubernetes/client-node`                      | Yes on K8s >= 1.33 (Go 1.24 default)                 | Cluster upgrade                                                 |
| WebSocket upgrade tokens              | SHA-256 of random 32-byte token                                    | 256-bit hash, 30-second TTL              | `session-service.ts`                           | Yes                                                  | Same as session tokens                                          |

### Implementation notes

- **Crypto abstraction layer**: `apps/api/src/services/crypto/signer.ts` defines `Signer` and `Verifier` interfaces with implementations: `Rs256Signer`, `HmacSha256Signer`, `HmacSha256Verifier`, and a stub `MlDsa65Signer` for future PQ support.
- **Timing-safe comparison**: Used in session validation, WebSocket token lookup, webhook verification, and internal HMAC auth — all via `crypto.timingSafeEqual()`.
- **Replay protection**: Both inbound GitHub webhooks (`tickets.ts`, 5-minute window) and internal pod auth (`hmac-auth-service.ts`, 5-minute window) validate timestamps to prevent replay attacks.

---

## 2. Data classifications and shelf lives

Every entry in the `secrets` table is encrypted with AES-256-GCM. The table below
matches each secret type to its expected shelf life and Mosca calculation.

### Mosca framework

The Mosca inequality determines when to begin migration:

> If **x + y > z**, you must migrate now.

Where:

- **x** = security shelf life (how long the data must remain confidential)
- **y** = migration time (how long it takes to deploy new crypto)
- **z** = time until a cryptographically relevant quantum computer (CRQC) exists

Current industry estimates place **z** at 10–15 years (2035–2040). Optio's
migration time (**y**) is estimated at 1–2 years for each primitive.

| Secret type                              | Example                   | Shelf life (x)              | x + y     | Migrate now? | Notes                                                              |
| ---------------------------------------- | ------------------------- | --------------------------- | --------- | ------------ | ------------------------------------------------------------------ |
| API keys (`ANTHROPIC_API_KEY`)           | Anthropic API key         | Short (rotatable, < 1 year) | 2–3 years | No           | Rotate regularly; HNDL risk is low                                 |
| OAuth tokens (`CLAUDE_CODE_OAUTH_TOKEN`) | Claude subscription token | Short (< 90 days)           | 1–2 years | No           | Auto-expires; cannot be used retroactively                         |
| GitHub tokens (`GITHUB_TOKEN`)           | PAT or installation token | Short (rotatable)           | 2–3 years | No           | Should be rotated periodically                                     |
| Webhook secrets                          | HMAC signing keys         | Medium (1–3 years typical)  | 3–5 years | No           | Only protects integrity, not confidentiality                       |
| Encryption key (`OPTIO_ENCRYPTION_KEY`)  | Master AES-256 key        | Long (life of deployment)   | 10+ years | Monitor      | AES-256 remains PQ-safe; risk is key exposure, not algorithm break |
| GitHub App private key                   | RSA PEM                   | Medium (1–3 years)          | 3–5 years | No           | JWTs expire in 10 minutes; HNDL value is minimal                   |
| Session tokens                           | User auth tokens          | Short (30-day TTL)          | 1–2 years | No           | Only hash is stored; token is ephemeral                            |

**Conclusion**: No secret type currently triggers the Mosca inequality for
immediate migration. AES-256-GCM (the only long-shelf-life primitive) is
PQ-safe. The primary area to monitor is the GitHub App RSA key, which is
not PQ-safe but has very low HNDL (harvest-now, decrypt-later) value due to
10-minute JWT expiry.

---

## 3. Key management

### `OPTIO_ENCRYPTION_KEY`

- **Generation**: `openssl rand -hex 32` (256 bits of entropy).
- **Storage**: Kubernetes Secret (`helm/optio/templates/secrets.yaml`), set via
  `encryption.key` in Helm values.
- **Parsing** (`secret-service.ts`):
  - If the value is a 64-character hex string: decoded directly as 32 bytes.
  - Otherwise: SHA-256 hashed to derive a 32-byte key. This fallback exists for
    convenience but hex input is strongly preferred.
- **Weak key detection**: At startup, `getEncryptionKey()` rejects known-weak
  values (`"change-me-in-production"`, `"changeme"`, `"test"`, `"secret"`,
  `"password"`, `"default"`) and throws an error.
- **Rotation**: Currently manual. To rotate:
  1. Generate a new key: `openssl rand -hex 32`
  2. Re-encrypt all secrets in the `secrets` table with the new key
  3. Update `encryption.key` in Helm values
  4. Redeploy the API
  - Automated rotation tooling is planned but not yet implemented.

### `OPTIO_CREDENTIAL_SECRET`

- **Derivation** (`credential-secret-service.ts`):
  - If `OPTIO_CREDENTIAL_SECRET` env var is set: used directly.
  - Otherwise: derived as `SHA-256("{OPTIO_ENCRYPTION_KEY}:credential-secret")`.
- **Helm template** (`secrets.yaml` line 60):
  ```yaml
  OPTIO_CREDENTIAL_SECRET: { { printf "%s:credential-secret" .Values.encryption.key | sha256sum } }
  ```
  This ensures the Helm-deployed value matches the runtime derivation.
- **Purpose**: Used by agent pods to authenticate to the API via HMAC signatures.
  The secret itself never crosses the wire — only HMAC signatures are transmitted.

### Webhook secrets

- **Per-webhook**: Each webhook has its own secret, stored AES-256-GCM encrypted
  in the database with AAD bound to `webhook:{url}:secret`.
- **GitHub inbound**: `GITHUB_WEBHOOK_SECRET` is stored as a global secret,
  configured during setup. With `OPTIO_REPO_WEBHOOKS` naming GitHub and none
  configured, Optio generates one (32 random bytes) for the repository hooks
  it registers and keeps it the same way.

### GitHub App private key

- **Storage**: `GITHUB_APP_PRIVATE_KEY` env var, delivered via Kubernetes Secret.
- **Format**: PEM-encoded RSA private key.
- **Used for**: Signing 10-minute JWTs to obtain GitHub App installation tokens.

---

## 4. Post-quantum posture

### Already PQ-safe

| Primitive                                       | Why it's safe                                                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| AES-256-GCM (secrets at rest)                   | Grover's algorithm reduces effective security to 128 bits, still well above the security margin. No known quantum speedup for GCM authentication. |
| SHA-256 (session tokens, credential derivation) | Grover's reduces pre-image resistance to 128 bits. Collision resistance reduced to 2^128 (still sufficient).                                      |
| HMAC-SHA256 (webhooks, internal auth)           | Same SHA-256 reasoning; HMAC construction adds no quantum vulnerability.                                                                          |
| Kubernetes API TLS on K8s >= 1.33               | Go 1.24 defaults to X25519MLKEM768 hybrid key exchange. See [docs/pq-readiness.md](pq-readiness.md).                                              |
| Outbound TLS to PQ-capable servers              | Node.js / OpenSSL negotiate X25519MLKEM768 when the server supports it.                                                                           |

### Pending migration

| Primitive                                               | Risk                                             | Blocker                                                           | Tracking |
| ------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------- | -------- |
| GitHub App JWT (RS256)                                  | Low — JWTs expire in 10 min, minimal HNDL value  | GitHub must add PQ-safe App authentication                        | #324     |
| Envoy sidecar CA (Ed25519)                              | Very low — ephemeral, intra-pod, 30-day validity | `OPTIO_ENVOY_CA_ALG=mldsa44` ready when OpenSSL 3.5+ ships ML-DSA | #326     |
| Helm-generated Postgres/Redis TLS CAs                   | Low — cluster-internal only                      | Helm `genCA` must support PQ algorithms                           | #327     |
| Outbound TLS to non-PQ servers (GitHub, Anthropic APIs) | Medium — depends on upstream                     | Upstream providers must enable hybrid TLS                         | #325     |

### Tracking issues

All post-quantum work is tracked under the `post-quantum` label:

- [#324](https://github.com/anthropics/optio/issues/324) — GitHub App PQ JWT migration
- [#325](https://github.com/anthropics/optio/issues/325) — Outbound TLS PQ hybrid enforcement
- [#326](https://github.com/anthropics/optio/issues/326) — Envoy sidecar ML-DSA CA migration
- [#327](https://github.com/anthropics/optio/issues/327) — Helm TLS CA PQ migration
- [#328](https://github.com/anthropics/optio/issues/328) — ML-DSA-65 webhook signing option
- [#329](https://github.com/anthropics/optio/issues/329) — AES-256-GCM V2 with mandatory AAD binding
- [#330](https://github.com/anthropics/optio/issues/330) — KMS-wrapped encryption key support
- [#331](https://github.com/anthropics/optio/issues/331) — PQ TLS metrics and observability
- [#333](https://github.com/anthropics/optio/issues/333) — This document (cryptography inventory)

### Hardening plan

The audit identified two categories of crypto-agility improvements:

1. **Algorithm selector pattern**: Already implemented for the Envoy CA
   (`OPTIO_ENVOY_CA_ALG` env var) and GitHub App JWT (`GITHUB_APP_JWT_ALG`).
   The `crypto/signer.ts` abstraction layer supports pluggable algorithms —
   `MlDsa65Signer` is stubbed and ready for implementation when Node.js crypto
   adds ML-DSA support.

2. **Ciphertext versioning**: `secret-service.ts` already includes algorithm
   version bytes (`ALG_AES_256_GCM_V1 = 0x01`, `ALG_AES_256_GCM_V2_AAD = 0x02`).
   This allows transparent migration to new encryption schemes without
   re-encrypting all existing data at once.

---

## 5. Compliance mapping

### CNSA 2.0 (NSA Commercial National Security Algorithm Suite 2.0)

| CNSA 2.0 requirement                    | Deadline           | Optio status                                                                                                         |
| --------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Prefer PQ algorithms for new software   | 2025               | Partial — symmetric crypto (AES-256, SHA-256, HMAC) is compliant; asymmetric (RSA, Ed25519) pending upstream support |
| Software/firmware signing: ML-DSA       | 2025               | N/A — Optio does not sign software releases                                                                          |
| Web browsers/servers: ML-KEM + ML-DSA   | 2025               | Partial — TLS 1.3 with ML-KEM hybrid available; ML-DSA TLS not yet standard                                          |
| Traditional public-key exclusive disuse | 2033               | On track — all non-PQ primitives have identified migration paths with external blockers (GitHub, Helm)               |
| Symmetric algorithms                    | No change required | Compliant — AES-256 and SHA-256/384 are CNSA 2.0 approved                                                            |

### FIPS 140-3

Optio does **not** currently claim FIPS 140-3 compliance. Relevant considerations:

- **Node.js OpenSSL**: Node.js can be built with OpenSSL in FIPS mode
  (`--openssl-is-fips`), but the standard Node.js distribution is not FIPS-validated.
- **AES-256-GCM**: FIPS-approved algorithm (SP 800-38D).
- **SHA-256, HMAC-SHA256**: FIPS-approved (FIPS 180-4, FIPS 198-1).
- **Ed25519**: Included in FIPS 186-5 (2023), but the OpenSSL implementation
  used by the Envoy sidecar may not be FIPS-validated.
- **RS256**: FIPS-approved (FIPS 186-4).

To achieve FIPS 140-3 compliance, Optio would need to:

1. Use a FIPS-validated Node.js build or OpenSSL provider
2. Ensure all crypto operations go through the validated module boundary
3. Restrict key sizes and algorithms to FIPS-approved values
4. Undergo formal validation (or use a validated crypto module)

---

## 6. How to verify PQ status in a running deployment

### Check TLS key exchange to upstream services

Use `tls.connect()` from inside the API pod to probe what key exchange group is
negotiated with a given upstream:

```bash
kubectl exec deploy/optio-api -n optio -- node -e '
const tls = require("tls");
const targets = [
  { host: "api.anthropic.com", port: 443 },
  { host: "api.github.com", port: 443 },
  { host: "kubernetes.default.svc", port: 443 },
];
for (const t of targets) {
  const sock = tls.connect(t.port, t.host, { servername: t.host }, () => {
    const info = sock.getEphemeralKeyInfo?.();
    console.log(`${t.host}: group=${info?.name ?? "unknown"} proto=${sock.getProtocol()}`);
    sock.end();
  });
  sock.on("error", (e) => console.log(`${t.host}: error=${e.code}`));
}
'
```

If the upstream supports hybrid PQ, you will see `group=x25519_mlkem768`.

### Check with OpenSSL CLI

```bash
kubectl exec deploy/optio-api -n optio -- \
  openssl s_client -connect api.github.com:443 \
  -groups X25519MLKEM768:X25519 \
  -brief 2>&1 | grep -E 'Protocol|Server Temp Key|Groups'
```

If the server supports ML-KEM hybrid, the output will show
`Server Temp Key: X25519MLKEM768`.

### Check Kubernetes API PQ status

See [docs/pq-readiness.md](pq-readiness.md) for the full verification procedure.
On K8s >= 1.33, the expected key exchange group is `x25519_mlkem768`.

### Check Envoy sidecar CA algorithm

```bash
# From inside an agent pod:
openssl x509 -in /etc/envoy/ca/ca.crt -noout -text | grep 'Public Key Algorithm'
# Expected: ED25519 (current) or id-ML-DSA-44 (after PQ migration)
```

### Metrics (when #331 lands)

The `optio_tls_handshake_total` Prometheus metric will expose:

```
optio_tls_handshake_total{target="api.github.com", group="x25519", version="TLSv1.3"} 42
optio_tls_handshake_total{target="kubernetes.default.svc", group="x25519_mlkem768", version="TLSv1.3"} 108
```

Use this to monitor PQ adoption across all outbound connections without manual
probing.
