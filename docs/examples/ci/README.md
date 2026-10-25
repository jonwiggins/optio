# Optional build and deploy pipelines

Copy `github-actions.yml` into `.github/workflows/` or `gitlab-ci.yml` to
`.gitlab-ci.yml` in a repository where you want these jobs to run. They are
examples, and are inactive in this repository. Both check and test the
workspace, build and push the same images, and deploy manually to a namespace
you choose. Review runner permissions and secret handling for your CI system.

Set `OPTIO_REGISTRY` to a registry path such as `registry.example.com/optio`;
provide its user/password through secrets. The Docker build runner needs
Docker buildx and access to a daemon. The optional helpers support BuildKit
rootless and a private CA through `OPTIO_CA_FILE` as a file path. The deployment
runner needs Helm and kubectl, a scoped kubeconfig, and your chart values.
`OPTIO_NAMESPACE` and `OPTIO_RELEASE` select the installation. Set
`OPTIO_URL` for smoke checks. No production/staging namespace is prescribed.

For offline builds, run the bundle creation and loading steps in
[air-gapped installations](../../air-gapped.md) first. Set
`OPTIO_TOOLCHAIN_VERSION` to the loaded kit version, and use a mirrored
`OPTIO_CI_IMAGE` (`build/ci-node:<kit-version>`) carrying `/pnpm-offline/store`.
Mirror the PostgreSQL, Redis, Docker and Helm/kubectl job images too. Helpers
can install from the bundled store; set `PNPM_STORE_DIR` to change its path.
No job downloads through a disconnected network unless its image or command
explicitly uses an accessible mirror.

`AGENT_CLIS`, `CLAUDE_CODE_VERSION`, `OPENCODE_INSTALL_METHOD` and
`PREINSTALL_MCP_SERVERS` configure a connected toolchain build. An offline build
uses the corresponding choices from its prebuilt kit. `build-image.sh` is a
helper for individual images with explicit build args and named contexts;
`check.sh`, `test.sh`, `chart.sh` and `smoke.sh` can also be run by hand.

To install an offline GitLab Kubernetes runner, the kit includes the runner
chart and runner/helper images. Choose versions matching your GitLab version,
set the chart's runner and helper image references to the mirror, and provide
a runner authentication token through GitLab's normal registration workflow.
The example pipelines do not install or administer runners.
