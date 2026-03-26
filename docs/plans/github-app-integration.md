# Plan: GitHub App Integration

**Status:** Approved, not started
**Created:** 2026-03-26

## Background

Optio currently requires a GitHub Personal Access Token (PAT) for all GitHub operations: PR watching, issue sync, auto-merge, repo detection, and git operations (clone/fetch/push) inside agent pods. PATs are tied to individual users, have broad scope, require manual rotation, and don't survive employee offboarding.

This plan replaces PATs with a GitHub App installation for all GitHub operations. A single GitHub App is registered per Optio deployment and installed on the organisation. Installation tokens (1-hour expiry) are generated on demand by the API server and served dynamically to agent pods via a credential helper.

## Design Decisions

### Single App per deployment

The GitHub App is deployment-wide, not per-workspace. All workspaces share the same app installation. This simplifies configuration (one set of credentials) and matches the "single org" deployment model.

### Token resolution order

All GitHub token consumers use a single resolution function:

1. GitHub App installation token (if configured)
2. Workspace-scoped `GITHUB_TOKEN` PAT (if exists)
3. Global `GITHUB_TOKEN` PAT (fallback)

Existing PAT-based deployments continue to work unchanged.

### Dynamic credential helper for pods

Repo pods are long-lived (`sleep infinity`) but installation tokens expire after 1 hour. Instead of baking a static token into `~/.git-credentials` at pod init, a git credential helper script calls the Optio API on every git auth request. The API caches the installation token in memory and refreshes it at ~50 minutes.

The `gh` CLI uses a wrapper script at `/usr/local/bin/gh` that fetches a fresh token from the API and sets the `GITHUB_TOKEN` env var before exec-ing the real `/usr/bin/gh`.

### API-centric token management

The app's private key stays in one place (the API server's secrets store). Pods never see the private key. Token generation, caching, and refresh all happen in `github-app-service.ts`. This avoids distributing the private key to every pod.

## GitHub App Permissions Required

Register a GitHub App with these permissions:

- **Repository permissions:**
  - Contents: Read & Write (clone, push, branch management)
  - Pull requests: Read & Write (create PRs, post comments, merge)
  - Issues: Read & Write (issue sync, label management, close on merge)
  - Checks: Read (CI status polling in PR watcher)
  - Metadata: Read (repo listing, detection)
- **Organisation permissions:**
  - Members: Read (optional, for repo listing)

Subscribe to webhook events: (optional, for future webhook-driven PR watching)

- Pull request
- Check run
- Issue comment

## Architecture

```
Pod git push
  --> /usr/local/bin/optio-git-credential (credential helper)
    --> curl http://optio-api:4000/api/internal/git-credentials
      --> github-app-service.ts
        --> cached token? return it (< 50 min old)
        --> expired? sign JWT (RS256, app private key)
          --> POST https://api.github.com/app/installations/{id}/access_tokens
          --> cache new token, return it

Pod gh pr create
  --> /usr/local/bin/gh (wrapper)
    --> curl http://optio-api:4000/api/internal/git-credentials
    --> export GITHUB_TOKEN=<token>
    --> exec /usr/bin/gh pr create ...

API PR watcher / issue sync / repo detect
  --> getGitHubToken(workspaceId?)
    --> isGitHubAppConfigured()? getInstallationToken() : retrieveSecretWithFallback("GITHUB_TOKEN")
```

## Implementation Phases

### Phase 1: GitHub App Service

**New file:** `apps/api/src/services/github-app-service.ts`

Responsibilities:

- `isGitHubAppConfigured(): boolean` -- checks if `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY` exist in the secrets store
- `generateJwt(): string` -- sign an RS256 JWT with the app's private key. Claims: `iss` = App ID, `iat` = now - 60s (clock skew), `exp` = now + 10min. Use `node:crypto` (`createSign("RSA-SHA256")`) to avoid adding a `jsonwebtoken` dependency.
- `getInstallationToken(): Promise<string>` -- return cached token if less than 50 minutes old. Otherwise generate a JWT, call `POST https://api.github.com/app/installations/{installationId}/access_tokens`, cache the response token and expiry, return it.
- Cache the private key PEM with a 5-minute TTL (read from secrets store, parse to `KeyObject`). This allows key rotation without API restart.

**Testing:** `apps/api/src/services/github-app-service.test.ts`

- Generate a test RSA key pair at test setup
- Test JWT generation (decode and verify claims)
- Test token caching: fresh token returned from cache, expired token triggers regeneration
- Mock the GitHub API call to `/app/installations/{id}/access_tokens`

### Phase 2: GitHub Token Resolution Service

**New file:** `apps/api/src/services/github-token-service.ts`

Single function:

```typescript
export async function getGitHubToken(workspaceId?: string | null): Promise<string> {
  // 1. GitHub App installation token (global, preferred)
  if (isGitHubAppConfigured()) {
    return getInstallationToken();
  }
  // 2. Workspace or global PAT (fallback)
  return retrieveSecretWithFallback("GITHUB_TOKEN", "global", workspaceId);
}
```

This is the single entry point. All existing `retrieveSecret("GITHUB_TOKEN")` calls are replaced with `getGitHubToken(workspaceId?)`.

**Testing:** `apps/api/src/services/github-token-service.test.ts`

- When app configured: returns installation token
- When app not configured: falls back to PAT (workspace then global)
- When neither configured: throws

### Phase 3: Internal Credentials Endpoint

**New file:** `apps/api/src/routes/github-app.ts`

Endpoints:

- `GET /api/internal/git-credentials` -- returns `{ token: "<installation_token>" }`. Called by the credential helper in pods. Add `/api/internal/` to `PUBLIC_ROUTES` in `apps/api/src/plugins/auth.ts` (no session cookie on pod-to-API requests). If GitHub App is not configured, falls back to reading `GITHUB_TOKEN` from secrets so the credential helper works with PATs too.
- `POST /api/github-app/test` -- accepts `{ appId, installationId, privateKey }`, attempts JWT generation and token exchange. Returns `{ valid: true, repos: number }` or `{ valid: false, error: string }`. Used by the setup wizard test button.
- `GET /api/github-app/status` -- returns `{ configured: boolean, appId?: string, installationId?: string }`. No secret values returned.

Register in `apps/api/src/server.ts`.

### Phase 4: Pod Credential Scripts

**New file:** `scripts/optio-git-credential`

```bash
#!/bin/bash
# Git credential helper — called by git with "get" on stdin.
# Fetches a fresh token from the Optio API.
while IFS= read -r line; do
  case "$line" in host=*) host="${line#host=}";; esac
  [ -z "$line" ] && break
done
if [ "$host" = "github.com" ]; then
  TOKEN=$(curl -sf "${OPTIO_GIT_CREDENTIAL_URL}" | jq -r '.token')
  if [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ]; then
    echo "protocol=https"
    echo "host=github.com"
    echo "username=x-access-token"
    echo "password=${TOKEN}"
  fi
fi
```

**New file:** `scripts/optio-gh-wrapper`

```bash
#!/bin/bash
# Wrapper for gh CLI — fetches a fresh GitHub token before each invocation.
export GITHUB_TOKEN=$(curl -sf "${OPTIO_GIT_CREDENTIAL_URL}" | jq -r '.token')
exec /usr/bin/gh "$@"
```

Both scripts are installed into `/usr/local/bin/` in agent images (Phase 5).

### Phase 5: Agent Image Updates

**Modified file:** `images/Dockerfile.base`

Add after existing tool installs:

```dockerfile
# Optio credential helpers for dynamic GitHub token refresh
COPY scripts/optio-git-credential /usr/local/bin/optio-git-credential
COPY scripts/optio-gh-wrapper /usr/local/bin/optio-gh-wrapper
RUN chmod +x /usr/local/bin/optio-git-credential /usr/local/bin/optio-gh-wrapper
```

The wrapper is NOT installed as `/usr/local/bin/gh` at image build time. It's activated at pod init time (Phase 6) by renaming the real `gh` and symlinking the wrapper. This keeps the image compatible with non-Optio usage.

All preset images (node, python, go, rust, full) inherit from base and get the scripts automatically. Rebuild all images with `./images/build.sh`.

### Phase 6: Pod Init & Task Worker Integration

**Modified file:** `scripts/repo-init.sh`

Replace the current static token block:

```bash
# Current code (lines 12-21):
if [ -n "${GITHUB_TOKEN:-}" ]; then
  git config --global credential.helper store
  echo "https://x-access-token:${GITHUB_TOKEN}@github.com" > ~/.git-credentials
  ...
fi
```

With:

```bash
if [ -n "${OPTIO_GIT_CREDENTIAL_URL:-}" ]; then
  # Dynamic credential helper — always-fresh tokens from Optio API
  git config --global credential.helper '/usr/local/bin/optio-git-credential'
  echo "[optio] Dynamic git credential helper configured"

  # Set up gh CLI wrapper for dynamic token refresh
  if [ -f /usr/bin/gh ] && [ -f /usr/local/bin/optio-gh-wrapper ]; then
    mv /usr/bin/gh /usr/bin/gh-real
    ln -s /usr/local/bin/optio-gh-wrapper /usr/bin/gh
    # Update wrapper to exec the real binary
    sed -i 's|/usr/bin/gh|/usr/bin/gh-real|' /usr/local/bin/optio-gh-wrapper
    echo "[optio] gh CLI wrapper configured"
  fi

  # Verify connectivity
  if curl -sf "${OPTIO_GIT_CREDENTIAL_URL}" > /dev/null 2>&1; then
    echo "[optio] Credential service reachable"
  else
    echo "[optio] WARNING: Credential service not reachable at ${OPTIO_GIT_CREDENTIAL_URL}"
  fi
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  # Fallback: static PAT (existing behavior)
  git config --global credential.helper store
  echo "https://x-access-token:${GITHUB_TOKEN}@github.com" > ~/.git-credentials
  chmod 600 ~/.git-credentials
  echo "[optio] Git credentials configured (static token)"
  echo "${GITHUB_TOKEN}" | gh auth login --with-token 2>/dev/null || true
  echo "[optio] GitHub CLI configured"
fi
```

**Modified file:** `apps/api/src/workers/task-worker.ts`

When building the env vars for pod creation (around line 280), add:

```typescript
// Inject dynamic credential URL if GitHub App is configured, or if a PAT exists
// (the credential endpoint handles both cases)
const credentialUrl = `http://${process.env.API_HOST ?? "optio-api"}:${process.env.API_PORT ?? "4000"}/api/internal/git-credentials`;
allEnv.OPTIO_GIT_CREDENTIAL_URL = credentialUrl;
```

Stop injecting `GITHUB_TOKEN` directly into the pod env when the GitHub App is configured. The credential helper fetches it on demand instead. When PAT-only, continue injecting `GITHUB_TOKEN` for backward compatibility (pods without the credential helper scripts).

```typescript
if (!isGitHubAppConfigured()) {
  // PAT mode: inject GITHUB_TOKEN for pods that may not have the credential helper
  const githubToken = await getGitHubToken(taskWorkspaceId).catch(() => null);
  if (githubToken) {
    allEnv.GITHUB_TOKEN = githubToken;
  }
}
```

**Modified file:** `apps/api/src/services/repo-pool-service.ts`

No changes needed -- env vars are passed through to `createRepoPod` already.

### Phase 7: Migrate Existing GitHub Token Consumers

Replace all direct `retrieveSecret("GITHUB_TOKEN")` calls with `getGitHubToken()`:

**`apps/api/src/workers/pr-watcher-worker.ts`:**

The current `getGithubToken(workspaceId)` function (which we added earlier in this session) uses `retrieveSecretWithFallback`. Replace the implementation:

```typescript
import { getGitHubToken } from "../services/github-token-service.js";

const getGithubTokenForTask = async (workspaceId: string | null): Promise<string | null> => {
  const cacheKey = workspaceId ?? "__global__";
  if (tokenCache.has(cacheKey)) return tokenCache.get(cacheKey)!;
  try {
    const token = await getGitHubToken(workspaceId);
    tokenCache.set(cacheKey, token);
    return token;
  } catch {
    tokenCache.set(cacheKey, null);
    return null;
  }
};
```

**`apps/api/src/services/repo-detect-service.ts`:**

Currently receives `githubToken` as a parameter. The caller (`routes/repos.ts`) fetches it. Update the caller to use `getGitHubToken()`.

**`apps/api/src/routes/issues.ts`:**

Currently reads `GITHUB_TOKEN` from secrets. Replace with `getGitHubToken()`.

**`apps/api/src/routes/setup.ts`:**

The setup validation endpoints receive the token from the user (testing a PAT). These stay as-is -- they validate user-provided tokens, not stored ones.

**`apps/api/src/routes/repos.ts`:**

The auto-detect block (lines 70-83) calls `retrieveSecret("GITHUB_TOKEN")`. Replace with `getGitHubToken()`.

### Phase 8: Helm Chart & Configuration

**Modified file:** `helm/optio/values.yaml`

Add under the `github` key (or create it):

```yaml
github:
  app:
    # GitHub App credentials (alternative to PAT-based GITHUB_TOKEN)
    # Register an app at https://github.com/organizations/{org}/settings/apps
    id: "" # App ID (integer, from app settings page)
    installationId: "" # Installation ID (from org install URL or API)
    privateKey: "" # PEM private key contents (generate from app settings)
```

**Modified file:** `helm/optio/templates/secrets.yaml`

Add conditionally:

```yaml
{{- if .Values.github.app.id }}
GITHUB_APP_ID: {{ .Values.github.app.id | quote }}
GITHUB_APP_INSTALLATION_ID: {{ .Values.github.app.installationId | quote }}
GITHUB_APP_PRIVATE_KEY: {{ .Values.github.app.privateKey | quote }}
{{- end }}
```

Note: The private key contains newlines. Helm's `quote` function handles this correctly in `stringData` blocks. Verify this works with a real PEM key during testing.

### Phase 9: Setup Wizard & Settings UI

**Modified file:** `apps/web/src/app/setup/page.tsx`

In the GitHub step (step ID "github"), add a toggle between two modes:

- **Personal Access Token** (current behavior)
- **GitHub App** (new)

When "GitHub App" is selected, show:

- App ID (text input, numeric)
- Installation ID (text input, numeric)
- Private Key (textarea, monospace, placeholder with PEM format hint)
- "Test Connection" button -- calls `POST /api/github-app/test` with the three values
- On success: shows accessible repo count, enables "Next" button
- On success: stores all three values via the secrets API (`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`)

The PAT input remains available as the other option. If the user has already configured a GitHub App, show its status and allow updating.

**Modified file:** `apps/web/src/lib/api-client.ts`

Add methods:

```typescript
testGitHubApp: (data: { appId: string; installationId: string; privateKey: string }) =>
  request<{ valid: boolean; repos?: number; error?: string }>("/api/github-app/test", {
    method: "POST",
    body: JSON.stringify(data),
  }),

getGitHubAppStatus: () =>
  request<{ configured: boolean; appId?: string; installationId?: string }>("/api/github-app/status"),
```

### Phase 10: Documentation

**Modified file:** `CLAUDE.md`

- Add "### GitHub App Authentication" section after "Authentication (Claude Code)"
- Document: app registration, required permissions, credential helper architecture, token refresh flow
- Update the `GITHUB_TOKEN` references to note it's a fallback when no app is configured
- Add to troubleshooting: "Git operations fail in pods" -- check credential helper connectivity, token endpoint

**Modified file:** `README.md`

- Update "How It Works" section to mention GitHub App as the recommended auth method
- Add GitHub App setup to Quick Start as an alternative to PAT

### Phase 11: Tests

**New file:** `apps/api/src/services/github-app-service.test.ts`

```
- generateJwt: produces valid RS256 JWT with correct claims (iss, iat, exp)
- getInstallationToken: returns fresh token on first call (mocks GitHub API)
- getInstallationToken: returns cached token on second call within 50 min
- getInstallationToken: refreshes token after 50 min
- isGitHubAppConfigured: returns true when all three secrets exist
- isGitHubAppConfigured: returns false when any secret is missing
- private key caching: re-reads from secrets store after TTL expires
```

**New file:** `apps/api/src/services/github-token-service.test.ts`

```
- getGitHubToken: returns installation token when app is configured
- getGitHubToken: falls back to workspace PAT when app not configured
- getGitHubToken: falls back to global PAT when workspace PAT missing
- getGitHubToken: throws when nothing is configured
```

**New file:** `apps/api/src/routes/github-app.test.ts`

```
- GET /api/internal/git-credentials: returns { token } when app configured
- GET /api/internal/git-credentials: returns { token } from PAT fallback
- GET /api/internal/git-credentials: returns 500 when nothing configured
- POST /api/github-app/test: returns { valid: true } with valid credentials
- POST /api/github-app/test: returns { valid: false } with invalid key
- GET /api/github-app/status: returns { configured: true } when set up
- GET /api/github-app/status: returns { configured: false } when not set up
```

## Risks

- **MEDIUM: Token caching and API restarts** -- if the API server restarts, the in-memory token cache is lost. The next git operation triggers a fresh token generation (adds ~500ms latency for that one call). Not a functional issue, just a brief delay.
- **MEDIUM: Agent image rebuild required** -- existing pods won't have the credential helper scripts. After deploying this feature, all agent images must be rebuilt (`./images/build.sh`) and existing repo pods must be recycled.
- **LOW: gh wrapper PATH ordering** -- the wrapper at `/usr/bin/gh` (symlink to wrapper) must exec `/usr/bin/gh-real`. The `repo-init.sh` handles the rename. If the image is updated with a new `gh` binary, the rename needs to happen again on next pod init (which it does, since `repo-init.sh` runs on every pod creation).
- **LOW: GitHub API rate limits** -- installation tokens share a 5000 req/hr rate limit. With many concurrent tasks, the PR watcher polling (every 30s per PR) and agent git operations could approach this. Mitigable by increasing the PR watch interval or using webhooks.
- **LOW: PEM key in Helm values** -- multi-line PEM content in YAML values can be tricky. The `stringData` field in K8s Secrets handles newlines correctly, but operators need to use YAML literal block scalars (`|`) in their values file.

## Backward Compatibility

- If no GitHub App is configured (`GITHUB_APP_ID` not set), all code paths fall through to the existing `GITHUB_TOKEN` PAT behavior
- Pods without the credential helper scripts (old images) continue to work with the static `GITHUB_TOKEN` env var injection
- The setup wizard offers both PAT and GitHub App options
- No database migrations required -- credentials stored via existing secrets table
- No breaking API changes
