# Deployment and Operations

## Helm Chart

At `helm/optio/`. Deploys the full stack to any K8s cluster.

Key `values.yaml` settings:

- `postgresql.enabled` / `redis.enabled` -- set to `false` and use `externalDatabase.url` / `externalRedis.url` for managed services
- `encryption.key` -- **required**, generate with `openssl rand -hex 32`
- `agent.imagePullPolicy` -- `Never` for local dev, `IfNotPresent` or `Always` for registries
- `ingress.enabled` -- set to `true` with hosts for production

The chart creates: namespace, ServiceAccount + RBAC (pod/exec/secret management), API deployment + service (with health probes), web deployment + service, conditional Postgres + Redis, configurable Ingress.

```bash
# Local dev (setup-local.sh handles this automatically)
helm install optio helm/optio -n optio --create-namespace \
  --set encryption.key=$(openssl rand -hex 32) \
  --set api.image.pullPolicy=Never \
  --set web.image.pullPolicy=Never \
  --set auth.disabled=true \
  --set api.service.type=NodePort --set api.service.nodePort=30400 \
  --set web.service.type=NodePort --set web.service.nodePort=30310 \
  --set postgresql.auth.password=optio_dev

# Production with managed services
helm install optio helm/optio -n optio --create-namespace \
  --set postgresql.enabled=false \
  --set externalDatabase.url="postgres://..." \
  --set redis.enabled=false \
  --set externalRedis.url="redis://..." \
  --set encryption.key=... \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=optio.example.com
```

## Production Deployment Checklist

1. **Encryption key**: Generate with `openssl rand -hex 32` and set via `encryption.key` in Helm values
2. **OAuth providers**: Configure at least one OAuth provider (set `*_CLIENT_ID` and `*_CLIENT_SECRET` env vars)
3. **Disable auth bypass**: Ensure `OPTIO_AUTH_DISABLED` is NOT set (or set to `false`)
4. **External database**: Use managed PostgreSQL -- set `postgresql.enabled=false` and `externalDatabase.url`
5. **External Redis**: Use managed Redis -- set `redis.enabled=false` and `externalRedis.url`
6. **Public URLs**: Set `API_PUBLIC_URL` and `WEB_PUBLIC_URL` to the actual deployment URLs (required for OAuth callbacks and auth cookie routing). `WEB_PUBLIC_URL` must be set on both the API and web deployments
7. **Web Docker build args**: Rebuild the web image with `--build-arg NEXT_PUBLIC_AUTH_DISABLED=false` and the correct `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_WS_URL` for the deployment
8. **Ingress**: Enable `ingress.enabled=true` with TLS and proper host configuration
9. **Agent image**: Push to a container registry and set `agent.imagePullPolicy=IfNotPresent` or `Always`
10. **GitHub token**: Set `GITHUB_TOKEN` secret for PR watching, issue sync, and repo detection
11. **Resource limits**: Tune pod resource requests/limits based on expected agent workload
12. **Metrics server**: Install `metrics-server` in the cluster for resource usage display

## Performance Tuning

- **`OPTIO_MAX_CONCURRENT`** (default 5): Global task concurrency. Increase for clusters with more resources.
- **`maxPodInstances`** (per-repo, default 1): Scale up for repos with high task throughput. Each instance gets its own PVC and K8s pod.
- **`maxAgentsPerPod`** (per-repo, default 2): Concurrent agents per pod. Increase if pods have sufficient CPU/memory. Total capacity = `maxPodInstances x maxAgentsPerPod`.
- **`maxConcurrentTasks`** (per-repo, default 2): Legacy concurrency limit. Effective limit is `max(maxConcurrentTasks, maxPodInstances x maxAgentsPerPod)`.
- **`OPTIO_REPO_POD_IDLE_MS`** (default 600000 / 10 min): How long idle pods persist. Increase to reduce cold starts for repos with sporadic traffic.
- **`OPTIO_PR_WATCH_INTERVAL`** (default 30s): PR polling interval. Increase to reduce GitHub API usage.
- **`OPTIO_HEALTH_CHECK_INTERVAL`** (default 60s): Health check and cleanup interval.
- **`maxTurnsCoding`** / **`maxTurnsReview`** (per-repo): Limit agent turns to control cost and runtime. Null falls back to global defaults.

## Troubleshooting

**Pod won't start / stays in provisioning**:

- Check `kubectl get pods -n optio` for pod status and events
- Verify the agent image exists locally: `docker images | grep optio-agent`
- Ensure `OPTIO_IMAGE_PULL_POLICY=Never` is set when using local images
- Check PVC availability: `kubectl get pvc -n optio`

**Agent fails immediately with auth error**:

- Verify `CLAUDE_AUTH_MODE` secret is set (`api-key` or `oauth-token`)
- For API key mode: ensure `ANTHROPIC_API_KEY` secret exists
- For OAuth token mode: ensure `CLAUDE_CODE_OAUTH_TOKEN` secret exists
- Check `GET /api/auth/status` for token validity

**Tasks stuck in `queued` state**:

- Check concurrency limits: `OPTIO_MAX_CONCURRENT` (global) and per-repo `maxConcurrentTasks`
- Verify no tasks are stuck in `provisioning` or `running` state (may need manual cancellation)
- Check the task worker logs for re-queue messages

**WebSocket connection drops / no live logs**:

- Ensure Redis is running and accessible
- Check that `REDIS_URL` is correctly configured
- Verify the web app's `NEXT_PUBLIC_API_URL` points to the correct API host

**Pod OOM-killed / crashed**:

- Check `pod_health_events` table for crash history
- Increase pod resource limits in the Helm chart or image preset
- The cleanup worker auto-detects crashes and fails associated tasks

**OAuth login fails**:

- Verify `API_PUBLIC_URL` and `WEB_PUBLIC_URL` match the actual deployment URLs (both must be reachable from the browser)
- Ensure OAuth callback URLs are registered with the provider (e.g., `{API_PUBLIC_URL}/api/auth/github/callback`)
- Check for `invalid_state` errors -- may indicate expired CSRF tokens (>10 min between login click and callback)
- If redirected to `/login` after successful OAuth: check that the `WEB_PUBLIC_URL` env var is set on the web deployment
- If `NEXT_PUBLIC_AUTH_DISABLED` is baked into the web Docker image at build time -- rebuild with `--build-arg NEXT_PUBLIC_AUTH_DISABLED=false` when enabling auth
- Cookie `Secure` flag is based on `WEB_PUBLIC_URL` scheme -- if serving over HTTP, ensure the URL starts with `http://` not `https://`

**Database migration errors**:

- Migrations auto-run on API server startup (via `drizzle-orm/postgres-js/migrator`)
- To manually generate a new migration: `cd apps/api && npx drizzle-kit generate`
- Note: there are some duplicate-numbered migration files from concurrent agent branches. The journal (`meta/_journal.json`) is authoritative -- un-journaled files are handled by prerequisite guards in later migrations.
