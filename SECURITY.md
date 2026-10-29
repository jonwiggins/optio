# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in Optio, please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities.
2. Use GitHub's **private vulnerability reporting** for this repository: open the **Security** tab and choose **Report a vulnerability** (or go directly to <https://github.com/jonwiggins/optio/security/advisories/new>). Include:
   - A description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)
3. You will receive an acknowledgment within 48 hours.
4. We will work with you to understand the issue and coordinate a fix before any public disclosure.

We ask that you give us reasonable time to address the issue before disclosing it publicly.

## Current Security Posture

### Authentication and authorization

The web UI and API require sign-in (GitHub, Google, GitLab or generic OIDC; see
`docs/sign-in.md`) unless `OPTIO_AUTH_DISABLED=true`, which is for local
development only. Sessions and personal access tokens are random 256-bit values
stored as SHA-256 hashes. Workspaces enforce admin / member / viewer roles, and
work, secrets and connections are either the organization's or one person's
(`docs/scope.md`). Actions on the whole deployment (global secrets, the Claude
token, ticket providers, cluster pods and upgrades) need a deployment admin:
anyone who can sign in can create a workspace and be its admin.

With GitHub or OIDC sign-in and no allowed domains, anyone with an account at
that provider can sign in. Restrict sign-in (allowed domains, your IdP) or keep
Optio on a private network.

### Encryption at Rest

Secrets stored in the database (e.g., API keys, tokens) are encrypted using **AES-256-GCM** with a configurable encryption key. Each secret has its own initialization vector (IV) and authentication tag. The encryption key is provided at deployment time via the `encryption.key` Helm value or the `OPTIO_ENCRYPTION_KEY` environment variable (`docs/cryptography.md`).

### Agent Execution

Agents (Claude Code, Codex, Copilot, Gemini, OpenCode, Cursor, Pi, OpenClaw) run inside isolated Kubernetes pods with git worktrees. Each task gets its own worktree within a shared repo pod. Agent pods use a separate ServiceAccount with no RBAC and no automounted Kubernetes token; only the API's ServiceAccount can manage pods.

Every agent runs with its permission checks skipped (Claude Code's `--dangerously-skip-permissions` and the equivalent for the others), which means the agent has full access to the filesystem and can execute arbitrary commands within the pod. This is necessary for the agent to function but means you should treat the pod environment as untrusted after agent execution.

Agents read untrusted text (issues, PR diffs, web pages) and must be assumed prompt-injectable. Agent pods get no Kubernetes token, a separate service account, and GitHub App tokens limited to their repo. Enable `networkPolicy.enabled` in production so agent pods reach only the API and the internet (cloud metadata is denied by default). Ask Optio always runs in an agent pod of its own, never as a child of the API process (`docs/optio-assistant.md`).

Past reviews and their open items: `docs/security-review-2026-10.md`, `docs/audits/security-audit-2026-10-26.md`, `docs/security-audit-2026-10-26.md`.

## Production Deployment Recommendations

If you plan to deploy Optio beyond a local development environment, consider the following hardening measures:

### Authentication and Authorization

- Configure a sign-in provider and restrict it (allowed domains, your IdP); never set `OPTIO_AUTH_DISABLED` outside local development
- Use the built-in workspace roles (admin / member / viewer) and keep deployment admins to a short list (`OPTIO_DEPLOYMENT_ADMINS`)

### Network Security

- Deploy behind a **reverse proxy** (nginx, Traefik, Caddy) that handles TLS termination
- Use **Kubernetes NetworkPolicies** to restrict pod-to-pod traffic within the cluster
- Restrict API and WebSocket access to known IP ranges or VPN connections
- Enable TLS for PostgreSQL and Redis connections

### Secrets Management

- Use a dedicated secrets manager (HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager) instead of the built-in encrypted-at-rest storage for high-sensitivity credentials
- Rotate the encryption key periodically
- Never log or expose secret values — Optio already enforces this in code, but verify in your deployment

### Kubernetes Hardening

- Run agent pods with a **read-only root filesystem** where possible
- Set resource limits (CPU, memory) on agent pods to prevent resource exhaustion
- Use **Pod Security Standards** (restricted or baseline) for the Optio namespace
- Limit the ServiceAccount permissions to the minimum required
- Consider using a container runtime sandbox (gVisor, Kata Containers) for agent pods

### Monitoring and Auditing

- Enable audit logging for the Kubernetes API server
- Monitor the `task_events` and `pod_health_events` tables for anomalous activity
- Set up alerts for failed tasks, crashed pods, and unusual agent behavior
- Review agent-generated PRs before merging — do not blindly auto-merge in production

### Supply Chain

- Pin container image versions in the Helm chart rather than using `latest`
- Scan agent images for vulnerabilities before deployment
- Use a private container registry with image signing

## Supported Versions

Optio is pre-1.0 software. Security fixes will be applied to the latest release only. There is no long-term support for older versions at this time.
