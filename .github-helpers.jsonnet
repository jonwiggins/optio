local base = import '.github/jsonnet/base.jsonnet';
local docker = import '.github/jsonnet/docker.jsonnet';
local misc = import '.github/jsonnet/misc.jsonnet';
local pnpm = import '.github/jsonnet/pnpm.jsonnet';

{
  nodeImage: 'mirror.gcr.io/node:22',
  project: 'unicorn-985',
  imageTag: 'deploy-${{ github.sha }}',
  baseImageRef: 'europe-docker.pkg.dev/unicorn-985/private-images/optio-agent-base:deploy-${{ github.sha }}',

  checkoutAndPnpm()::
    misc.checkout(preferSshClone=false, includeSubmodules=false) +
    pnpm.install(),

  buildImage(name, dockerfile, buildArgs=null)::
    docker.buildDocker(
      name,
      imageTag=self.imageTag,
      isPublic=false,
      dockerfile=dockerfile,
      project=self.project,
      build_args=buildArgs,
    ),

  pnpmJob(name, commands)::
    base.ghJob(
      name,
      image=self.nodeImage,
      useCredentials=false,
      steps=[
        self.checkoutAndPnpm(),
      ] + [
        base.step(cmd.name, cmd.run)
        for cmd in commands
      ],
    ),
}
