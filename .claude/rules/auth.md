# Authentication

## Web UI / API Authentication

Multi-provider OAuth for the web UI and API. Three providers are supported:

- **GitHub** (`apps/api/src/services/oauth/github.ts`) -- scopes: `read:user user:email`
- **Google** (`apps/api/src/services/oauth/google.ts`) -- scopes: `openid email profile`
- **GitLab** (`apps/api/src/services/oauth/gitlab.ts`) -- scopes: `read_user`

Enable a provider by setting both `<PROVIDER>_OAUTH_CLIENT_ID` and `<PROVIDER>_OAUTH_CLIENT_SECRET` env vars (e.g., `GITHUB_OAUTH_CLIENT_ID`). GitLab also accepts `GITLAB_OAUTH_BASE_URL` for self-hosted instances.

### OAuth flow (exchange-code pattern)

Uses exchange-code pattern to avoid cross-origin cookie issues (API and web run on different ports/hosts):

1. `GET /api/auth/:provider/login` -> redirect to OAuth provider
2. Provider calls back to `GET /api/auth/:provider/callback`
3. API upserts user, creates session (SHA256-hashed token in `sessions` table)
4. API creates a short-lived, one-time exchange code (30s TTL, in-memory)
5. API redirects to `WEB_PUBLIC_URL/auth/callback?code=xxx`
6. Next.js route handler (`apps/web/src/app/auth/callback/route.ts`) exchanges the code via `POST /api/auth/exchange` for the real session token
7. Web app sets two cookies on its own origin: `optio_session` (HttpOnly, for middleware) and `optio_token` (JS-readable, for API client Bearer auth)
8. Redirects to `/`

### Auth middleware

`apps/api/src/plugins/auth.ts`: `preHandler` hook on all routes except `/api/health`, `/api/auth/*`, `/api/setup/*`. Accepts session token from cookie, `Authorization: Bearer` header, or `?token=` query param (WebSocket). Next.js middleware (`apps/web/src/middleware.ts`) redirects unauthenticated users to `/login`.

### API client auth

The browser reads the `optio_token` cookie and sends it as an `Authorization: Bearer` header on all API requests (`apps/web/src/lib/api-client.ts`).

### Logout

`POST /auth/logout` (web-side route handler) clears both cookies and revokes the API session. The API's `POST /api/auth/logout` is called internally by the web route.

### Local dev bypass

Set `OPTIO_AUTH_DISABLED=true` (API) and `NEXT_PUBLIC_AUTH_DISABLED=true` (web, baked at Docker build time) to skip all auth checks. `GET /api/auth/me` returns a synthetic "Local Dev" user.

### Secure cookie flag

Based on the URL scheme of `WEB_PUBLIC_URL`, not `NODE_ENV`. This prevents cookies from being silently dropped when serving over HTTP (e.g., local Kind cluster with NodePort).

### Key routes

- `GET /api/auth/providers` -- list enabled providers
- `GET /api/auth/me` -- current user profile
- `POST /api/auth/exchange` -- exchange short-lived auth code for session token
- `POST /api/auth/logout` -- revoke session (called by web logout route)

## Claude Code Authentication

Three modes, selected during the setup wizard:

**API Key mode**: `ANTHROPIC_API_KEY` is injected as an env var into the container. Simple, pay-per-use.

**OAuth Token mode** (recommended for k8s): User extracts their Claude Max/Pro OAuth token from the macOS Keychain via a one-liner in the setup wizard, then pastes it. The token is stored as an encrypted secret (`CLAUDE_CODE_OAUTH_TOKEN`) and injected into agent pods. This gives full subscription access including usage tracking.

**Max Subscription mode** (legacy, local dev only): The API server reads credentials directly from the host's macOS Keychain or `~/.claude/.credentials.json`. Only works when the API runs on the host machine, not in k8s.

The auth service is at `apps/api/src/services/auth-service.ts`. For usage tracking, it falls back to reading `CLAUDE_CODE_OAUTH_TOKEN` from the secrets store when the Keychain is unavailable (k8s deployments).

## Workspaces (multi-tenancy)

Workspaces provide multi-tenant isolation. All resources (tasks, repos, secrets, pods, webhooks, workflows, MCP servers, skills) are scoped by `workspaceId`. Migration `0022_workspaces.sql` creates a default workspace and assigns all existing data to it.

**Tables**: `workspaces` (id, name, slug, description, createdBy) and `workspace_members` (workspaceId, userId, role). Every resource table has a nullable `workspaceId` column for backward compatibility.

**Roles**: `admin` (full workspace control, member management), `member` (create/edit resources), `viewer` (read-only).

**Context resolution** (`plugins/auth.ts`): The active workspace is determined from the `x-workspace-id` request header or `optio_workspace` cookie. The auth middleware validates the user's membership, falls back to their `defaultWorkspaceId` if the requested workspace is invalid, and always ensures a workspace exists via `ensureUserHasWorkspace()`.

**Secret isolation**: Each workspace has its own secrets (unique constraint on `name, scope, workspaceId`). Workers use `retrieveSecretWithFallback()` which tries the task's workspace first, then falls back to global.

**Repo isolation**: Repos have a unique constraint on `(repoUrl, workspaceId)` -- the same repository can be configured independently in different workspaces with different image presets, prompts, and settings.

**Key routes**:

- `GET/POST /api/workspaces` -- list/create workspaces
- `GET/PATCH/DELETE /api/workspaces/:id` -- read/update/delete
- `POST /api/workspaces/:id/switch` -- switch active workspace
- `GET/POST /api/workspaces/:id/members` -- list/add members
- `PATCH/DELETE /api/workspaces/:id/members/:userId` -- update role/remove
