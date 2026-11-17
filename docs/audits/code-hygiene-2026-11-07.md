# Code hygiene pass — 7 November 2026

A grep-level pass over the API, web, CLI and shared packages for the
patterns that cause security bugs, plus a check of the HTTP security
headers, cookies and CORS and a secret scan of the tree and its history.
It builds on the [October review](../security-review-2026-10.md) and the
[26 October audit](security-audit-2026-10-26.md) (with its
[follow-up](../security-audit-2026-10-26.md)) and does not repeat them: the
open items listed there — optional generic-webhook secrets, cross-workspace
event matching, unregistered repo URLs, non-expiring git helper keys,
plaintext trigger secrets, supply-chain pinning — are still open and are not
re-reported here.

Like those, this is a code review, not a penetration test.

## What was checked

| Area                      | Where                                                                                                                                                                                                    | Result                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web response headers      | `apps/web/next.config.ts` `headers()`, tested in `apps/web/src/security-headers.test.ts`                                                                                                                 | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(self), geolocation=()` (dictation needs the microphone), `Content-Security-Policy-Report-Only` (below), HSTS when `NODE_ENV=production`. The web renders no `<iframe>`, so `DENY` costs nothing. |
| API response headers      | `apps/api/src/server.ts` `onRequest` hook                                                                                                                                                                | `nosniff`, `DENY`, `Referrer-Policy` were there (October). **HSTS added** when `PUBLIC_URL` / `PUBLIC_API_URL` is `https://`, with the web's value. Tests added in `server.test.ts`.                                                                                                                                                                         |
| Cookies                   | `apps/web/src/lib/auth-cookies.ts`, `app/auth/callback/route.ts`, `app/api/[...path]/route.ts`, `apps/api/src/routes/auth.ts` (logout)                                                                   | The session and OAuth-verifier cookies are `HttpOnly; SameSite=Lax; Path=/`, `Secure` and `__Host-`-prefixed when `PUBLIC_URL` is https. The BFF proxy forwards no `Set-Cookie` from the API. Nothing to change.                                                                                                                                             |
| CORS                      | `server.ts` (`@fastify/cors`), `utils/browser-origin.ts`                                                                                                                                                 | `credentials: true` with an explicit origin list: `OPTIO_ALLOWED_ORIGINS`, else none in production, else two localhost origins. Never `*`. Cookie-authenticated mutations and WebSocket upgrades also check `Origin` (`browserOriginAllowed`). Native apps send Bearer tokens and no `Origin`.                                                               |
| Redirects                 | every `reply.redirect` / `NextResponse.redirect` in `routes/auth.ts`, the web callback, proxy and middleware                                                                                             | Targets are `WEB_URL`, `PUBLIC_URL`, the provider's authorize URL, or the CLI loopback callback (`validateCliCallback`: `http://` + loopback host, no credentials). The middleware's `?redirect=` is written but never read, so it cannot be an open redirect.                                                                                               |
| Server-side fetches       | every `fetch(` in `apps/api/src`                                                                                                                                                                         | URLs people type go through `guardedFetch` (`packages/shared/src/utils/outbound-http.ts`: scheme and host vetting, DNS pinning, manual redirects, 10 s timeout). The raw `fetch` calls left target fixed vendor hosts (Anthropic, Google, GitHub, GHCR, Bitbucket, GitLab OAuth) or an https-only, deployment-admin-configured IdP.                          |
| Secret comparison         | `utils/webhook-signature.ts`, `routes/hooks.ts`, `crypto/signer.ts`, `hmac-auth-service.ts`, `controller-auth.ts`, `sign-in-config-service.ts` (setup token), `api-key-service.ts`, `session-service.ts` | All `timingSafeEqual` after a length check; sessions, PATs and agent tokens are looked up by SHA-256 hash. No `===` on a signature or shared secret was found.                                                                                                                                                                                               |
| `JSON.parse` at the edge  | `routes/*.ts`                                                                                                                                                                                            | Seven sites: Slack (after signature verification, shape checked), Redis-stored OAuth state (ours), a stored connection's secret JSON. Request bodies otherwise go through the Zod type provider.                                                                                                                                                             |
| Shell command building    | `child_process` and every `["bash", "-c", script]` exec in `apps/api/src`, `packages/container-runtime`                                                                                                  | No `exec`/`execSync` with a built string (one constant `security find-generic-password`). Pod scripts interpolate ids that are regex-checked first (`isRemovableRunDir`, `listTaskBranchesInPod`) or come from the server. One hygiene item below.                                                                                                           |
| File paths from requests  | `path.join` / `path.resolve` in routes, services and the CLI                                                                                                                                             | Config-as-code resolves inside its root (`insideReal`); Local transcripts check the session id against a regex. One CLI item fixed below.                                                                                                                                                                                                                    |
| Randomness                | `Math.random(` outside tests                                                                                                                                                                             | Jitter, backoff, BullMQ job-id suffixes and pod-name suffixes (fine). **Two default webhook paths in the web fixed** (below). Server-side trigger secrets use `randomBytes(24)`.                                                                                                                                                                             |
| Weak hashes               | `createHash("md5")`, `createHash("sha1")`                                                                                                                                                                | One SHA-1: a deterministic id for a Codex transcript line (`apps/cli/src/local/codex-transcript.ts`), not security.                                                                                                                                                                                                                                          |
| `eval` / `new Function`   | all source                                                                                                                                                                                               | None (the one `.eval(` is a Redis Lua script).                                                                                                                                                                                                                                                                                                               |
| `dangerouslySetInnerHTML` | `apps/web/src/app/layout.tsx` (2), `apps/site` (2)                                                                                                                                                       | Static: a theme bootstrap script, `window.__OPTIO_CONFIG` from server env with `<` escaped, and JSON-LD on the static site.                                                                                                                                                                                                                                  |

## Changed

- **API HSTS** — `apps/api/src/server.ts` sends `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` when `PUBLIC_URL` or `PUBLIC_API_URL` starts with `https://` (`servedOverTls`), the same value the web app sends, since the ingress serves both on one host and a browser keeps the last value it saw. Nothing over plain HTTP. Tests cover both cases and the three baseline headers, including on error responses.
- **Default webhook paths** — the New work form and the Local automations form filled a generic webhook trigger's path with `hook-` + eight `Math.random()` base-36 characters (about 41 bits from a predictable generator). Because a generic webhook may have no shared secret (known open item), the path is the only thing guarding the trigger. Both now use `randomSlug()` (`apps/web/src/lib/random-slug.ts`): 16 characters from `crypto.getRandomValues`, 80 bits, no modulo bias. Tested.
- **`optio export -o DIR`** — wrote each manifest at `path.resolve(DIR, m.path)` with `m.path` from the server. The server slugs the name, but the CLI now refuses a path that resolves outside `DIR` (`exportFilePath`, tested) rather than trusting any server it talks to.
- **Secret scanning** — `.gitleaks.toml` (default rules + a commented allowlist), a `Secret scan` step in CI's `checks` job (pinned gitleaks 8.30.1 tarball, sha256-verified, `gitleaks dir . --exit-code 1`, a few seconds over the working tree), and a pre-commit scan of the staged changes that runs only when `gitleaks` is on the PATH.

## Secret scan results

`gitleaks dir .` (working tree) found 18 matches and `gitleaks git` (1,899
commits) found 54 before the allowlist. Every one was inspected:

- Android unit tests and fixtures: made-up `optio_pat_…` tokens, device tokens and a fixture token id.
- API tests: the fake SAML IdP's self-signed keys, a self-signed localhost TLS key in `outbound-url.test.ts`, an invented GitLab runner token and JWT in a log-redaction test, a made-up BullMQ repeat key, the documented placeholder encryption key (`0123…cdef`, also in `docs/examples/ci/chart.sh`).
- Deleted test files that only history meets: a self-signed localhost key/cert in the former SMTP and GitLab TLS tests, `sk-or-v1-abcdef` and `optio_pat_fresh123` stand-ins.
- Docs: image digests and a TLS key-exchange group name read as keys.

**No production secret was found in the tree or in history.** With the
allowlist both scans report none. This agrees with the 26 October audit's
classification and, like it, is not proof that nothing was ever exposed.

## Open

| Sev  | Where                                       | Finding                                                                                                                                                                                                                  | Proposal                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Low  | `apps/api/src/ws/session-terminal.ts:79-98` | The session setup script interpolates `session.branch` and `worktreePath` inside double quotes (`git worktree add "${worktreePath}" -b "${branch}"`). A branch containing `$(`, a backquote or `"` would run in the pod. | Not an escalation — the person who names the branch is about to get a shell in that pod — but quote through `shellQuote` (`@optio/shared`) or validate the branch with `git check-ref-format` rules at creation, as `listTaskBranchesInPod` does for ids.                                                                                                                                             |
| Low  | `apps/web/next.config.ts`                   | HSTS is sent when `NODE_ENV=production`, not when the site is https. Harmless (browsers ignore HSTS over plain HTTP) but not the same rule the API now uses.                                                             | Gate on `PUBLIC_URL.startsWith("https://")` as well, after confirming every production deployment sets `PUBLIC_URL`.                                                                                                                                                                                                                                                                                  |
| Info | `apps/web/next.config.ts`                   | The CSP is report-only and needs `'unsafe-inline'` for scripts: Next's hydration scripts and the two `dangerouslySetInnerHTML` scripts in `app/layout.tsx` (theme bootstrap, `window.__OPTIO_CONFIG`).                   | Enforce in stages: move the two inline scripts to nonces or hashes (Next supports a per-request nonce through middleware `x-nonce`), keep `'unsafe-inline'` for styles (Tailwind runtime classes, Recharts inline `style`), `img-src` as is, `connect-src 'self' wss: ws:` plus `PUBLIC_API_URL`, `worker-src 'self' blob:` for xterm.js, `frame-ancestors 'none'`. Nothing in this pass turns it on. |
| Info | `apps/site`                                 | The static marketing site (`output: "export"`) sets no headers; they must come from its host.                                                                                                                            | Set `nosniff`, `X-Frame-Options`, `Referrer-Policy` at the CDN / Pages configuration.                                                                                                                                                                                                                                                                                                                 |
| Info | `apps/api/src/server.ts`                    | No `Cross-Origin-Resource-Policy` / `Cross-Origin-Opener-Policy` on API responses.                                                                                                                                       | `Cross-Origin-Resource-Policy: same-site` is safe for the native apps (CORP affects browser `no-cors` loads only) once every web deployment is confirmed same-site with its API.                                                                                                                                                                                                                      |

## Recommended lint rules (for the ESLint owner)

The sweep is a grep; these keep the findings from coming back. All are
`error` in `apps/api/src/**` and `apps/cli/src/**`, with the test globs and
the places named below excepted.

```js
// child_process: spawn/execFile with an argv array only.
"no-restricted-properties": ["error",
  { object: "child_process", property: "exec", message: "Use execFile/spawn with an argv array." },
  { object: "child_process", property: "execSync", message: "Use execFileSync/spawnSync with an argv array." },
],
"no-restricted-imports": ["error", { paths: [
  { name: "node:child_process", importNames: ["exec", "execSync"], message: "Use execFile/spawn with an argv array." },
  { name: "child_process", importNames: ["exec", "execSync"], message: "Use execFile/spawn with an argv array." },
]}],
// Never JS eval. (`redis.eval` is a member call and is not matched.)
"no-eval": "error",
"no-implied-eval": "error",
"no-new-func": "error",
// One no-restricted-syntax per config block (the rule takes a list of selectors).
"no-restricted-syntax": ["error",
  // Math.random is for jitter only; ids, paths and tokens come from node:crypto.
  // Scope: apps/api/src/services/**, apps/api/src/routes/**, apps/web/src/components/**,
  // apps/web/src/lib/** (the workers' and packages/shared/src/reconcile/** backoff jitter stays allowed).
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: "Not for anything that must be unguessable: use crypto.randomBytes / randomUUID (server) or crypto.getRandomValues (browser, lib/random-slug.ts).",
  },
  // Weak digests only as explicit fingerprints.
  {
    selector: "CallExpression[callee.name='createHash'] > Literal[value=/^(md5|sha1)$/]",
    message: "MD5 / SHA-1 are fingerprints, not security: use sha256, and say why if a fingerprint needs them.",
  },
],
// Single-string shell commands in pod execs are the real surface; flag the shape so a reviewer
// looks (a separate "warn" block: ["bash", "-c", CONSTANT_SCRIPT] is common and fine).
"no-restricted-syntax": ["warn", {
  selector: "ArrayExpression > Literal[value='-c'] ~ TemplateLiteral",
  message: "A template literal after `-c`: every interpolated value must be validated or shellQuote()d.",
}],
```

For the web: `react/no-danger` as `warn` in `apps/web/src/**` with the two
`app/layout.tsx` sites disabled inline and commented, so a new
`dangerouslySetInnerHTML` is a review item.

## Verification

Unit tests for the API server headers, the web `randomSlug` and the CLI
`exportFilePath`; `gitleaks dir` and `gitleaks git` clean with the
allowlist; the repository's push gate (`pnpm check:push`) and CI on the
pull request.
