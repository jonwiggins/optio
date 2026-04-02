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

// ── Build Agent Images ──────────────────────────────────────────────────────
local agentPresets = ['node', 'python', 'go', 'rust', 'full'];

local buildImages = base.pipeline(
  'Build Agent Images',
  [
    base.ghJob(
      'build-base',
      image=optio.nodeImage,
      useCredentials=false,
      steps=[
        misc.checkout(preferSshClone=false, includeSubmodules=false),
        optio.buildImage('optio-agent-base', 'images/base.Dockerfile'),
      ],
    ),
  ] + [
    base.ghJob(
      'build-' + preset,
      image=optio.nodeImage,
      useCredentials=false,
      needs=['build-base'],
      steps=[
        misc.checkout(preferSshClone=false, includeSubmodules=false),
        optio.buildImage(
          'optio-agent-' + preset,
          'images/' + preset + '.Dockerfile',
          buildArgs='BASE_IMAGE=' + optio.baseImageRef,
        ),
      ],
    )
    for preset in agentPresets
  ],
  event={
    push: {
      branches: ['main'],
      tags: ['v*'],
      paths: ['images/**', 'scripts/repo-init.sh', 'scripts/agent-entrypoint.sh', '.github/workflows/Build Agent Images.yml'],
    },
    workflow_dispatch: null,
  },
);

// ── Release ─────────────────────────────────────────────────────────────────
local releaseServices = [
  { name: 'api', dockerfile: 'Dockerfile.api' },
  { name: 'web', dockerfile: 'Dockerfile.web' },
  { name: 'optio', dockerfile: 'Dockerfile.optio' },
];

local release = base.pipeline(
  'Release',
  [
    base.ghJob(
      'build-' + svc.name,
      image=optio.nodeImage,
      useCredentials=false,
      steps=[
        misc.checkout(preferSshClone=false, includeSubmodules=false),
        optio.buildImage('optio-' + svc.name, svc.dockerfile),
      ],
    )
    for svc in releaseServices
  ] + [
    base.ghJob(
      'build-agent-base',
      image=optio.nodeImage,
      useCredentials=false,
      steps=[
        misc.checkout(preferSshClone=false, includeSubmodules=false),
        optio.buildImage('optio-agent-base', 'images/base.Dockerfile'),
      ],
    ),
  ] + [
    base.ghJob(
      'build-agent-' + preset,
      image=optio.nodeImage,
      useCredentials=false,
      needs=['build-agent-base'],
      steps=[
        misc.checkout(preferSshClone=false, includeSubmodules=false),
        optio.buildImage(
          'optio-agent-' + preset,
          'images/' + preset + '.Dockerfile',
          buildArgs='BASE_IMAGE=' + optio.baseImageRef,
        ),
      ],
    )
    for preset in agentPresets
  ] + [
    base.ghJob(
      'deploy',
      image=optio.nodeImage,
      useCredentials=false,
      needs=['build-api', 'build-web', 'build-optio'] + ['build-agent-' + p for p in agentPresets],
      steps=[
        misc.checkout(preferSshClone=false, includeSubmodules=false),
        helm.deployHelm(
          clusters['gh-runners'],
          release='optio',
          values={ image: { tag: optio.imageTag } },
          chartPath='./helm/optio',
          namespace='optio',
        ),
      ],
    ),
  ],
  event={
    push: { tags: ['v*'] },
    workflow_dispatch: null,
  },
);

// ── Deploy Site ─────────────────────────────────────────────────────────────
local deploySite = base.pipeline(
  'Deploy Site',
  [
    base.ghJob(
      'build',
      image=optio.nodeImage,
      useCredentials=false,
      steps=[
        optio.checkoutAndPnpm(),
        base.step('Build site', 'pnpm turbo build --filter=@optio/site'),
        base.action('Upload Pages artifact', 'actions/upload-pages-artifact@v3', with={ path: 'apps/site/out' }),
      ],
    ),
    base.ghJob(
      'deploy',
      image=optio.nodeImage,
      useCredentials=false,
      needs=['build'],
      steps=[
        base.action('Deploy to Pages', 'actions/deploy-pages@v4', id='deployment'),
      ],
    ),
  ],
  event={
    push: {
      branches: ['main'],
      paths: ['apps/site/**', '.github/workflows/Deploy Site.yml'],
    },
    workflow_dispatch: null,
  },
  permissions={ contents: 'read', pages: 'write', 'id-token': 'write' },
  concurrency={ group: 'pages', 'cancel-in-progress': false },
);

ci + buildImages + release + deploySite
