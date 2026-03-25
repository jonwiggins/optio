# feat: Helm chart production hardening

feat: Helm chart production hardening

## Problem

The Helm chart works for local dev but isn't production-ready.

## Missing

- **TLS**: No cert-manager integration or default TLS configuration for ingress
- **Resource quotas**: No namespace-level quotas — rogue agents can consume all cluster resources
- **Multi-replica API**: Default `replicas: 1` with no leader election story for BullMQ workers
- **Agent PVCs**: Chart doesn't create PVCs for repo pod home directories
- **Pod anti-affinity**: No rules to spread API/web across nodes
- **Image pull secrets**: No support for pulling from private registries
- **Secure defaults**: Postgres password defaults to `optio-prod-change-me`, auth disabled by default

## Acceptance Criteria

- [ ] Ingress TLS with cert-manager annotation support
- [ ] Namespace resource quotas configurable in values.yaml
- [ ] API replica count configurable with documented worker scaling story
- [ ] Agent PVC template included
- [ ] Pod anti-affinity rules for API and web
- [ ] Image pull secret support
- [ ] Secure defaults (require encryption key, require auth in production)

---

_Optio Task ID: 8b558fe5-bb2e-4568-84f7-f06b96af2674_
