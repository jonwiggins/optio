local base = import '.github/jsonnet/base.jsonnet';
local clusters = import '.github/jsonnet/clusters.jsonnet';
local docker = import '.github/jsonnet/docker.jsonnet';
local helm = import '.github/jsonnet/helm.jsonnet';
local misc = import '.github/jsonnet/misc.jsonnet';
local optio = import '.github-helpers.jsonnet';

// ── CI ──────────────────────────────────────────────────────────────────────
local ci = base.pipeline(
  'CI',
  [
    optio.pnpmJob('format', [{ name: 'Format check', run: 'pnpm format:check' }]),
    optio.pnpmJob('typecheck', [{ name: 'Typecheck', run: 'pnpm turbo typecheck' }]),
    optio.pnpmJob('test', [{ name: 'Test', run: 'pnpm turbo test' }]),
    optio.pnpmJob('build-web', [{ name: 'Build web', run: 'cd apps/web && npx next build' }]),
    optio.pnpmJob('build-site', [{ name: 'Build site', run: 'cd apps/site && npx next build' }]),
    base.ghJob(
      'build-image',
      image=optio.nodeImage,
      useCredentials=false,
      steps=[
        misc.checkout(preferSshClone=false, includeSubmodules=false),
        optio.buildImage('optio-agent-base', 'images/base.Dockerfile'),
        optio.buildImage('optio-agent-node', 'images/node.Dockerfile'),
      ],
    ),
  ],
  event={ push: { branches: ['main'] }, pull_request: { branches: ['main'] } },
);

ci
