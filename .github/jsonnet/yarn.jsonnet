local base = import 'base.jsonnet';
local cache = import 'cache.jsonnet';
local images = import 'images.jsonnet';
local misc = import 'misc.jsonnet';

{
  /**
   * Creates a step to run yarn install with caching and retry logic.
   *
   * @param {string} [ifClause=null] - Conditional expression to determine if step should run
   * @param {boolean} [prod=false] - Whether to install only production dependencies
   * @param {string} [workingDirectory=null] - Directory to run yarn in
   * @param {boolean} [ignoreEngines=false] - Whether to ignore engine version checks
   * @param {object} [env={}] - Additional environment variables for the step
   * @returns {steps} - Array containing a single step object
   */
  yarn(ifClause=null, prod=false, workingDirectory=null, ignoreEngines=false, env={})::
    base.step(
      'yarn' + (if prod then '-prod' else ''),
      run='yarn --cache-folder .yarncache --frozen-lockfile --prefer-offline' + (if ignoreEngines then ' --ignore-engines' else '') + (if prod then ' --prod' else '') + ' || yarn --cache-folder .yarncache --frozen-lockfile --prefer-offline' + (if ignoreEngines then ' --ignore-engines' else '') + (if prod then ' --prod' else ''),
      ifClause=ifClause,
      workingDirectory=workingDirectory,
      env=env,
    ),

  /**
   * Creates a step to configure npm token for Gynzy registry (alias for setGynzyNpmToken).
   *
   * @param {string} [ifClause=null] - Conditional expression to determine if step should run
   * @param {string} [workingDirectory=null] - Directory to create .npmrc file in
   * @returns {steps} - Array containing a single step object
   */
  setNpmToken(ifClause=null, workingDirectory=null):: self.setGynzyNpmToken(ifClause=ifClause, workingDirectory=workingDirectory),

  /**
   * Creates a step to configure npm token for Gynzy's private registry.
   *
   * @param {string} [ifClause=null] - Conditional expression to determine if step should run
   * @param {string} [workingDirectory=null] - Directory to create .npmrc file in
   * @returns {steps} - Array containing a single step object
   */
  setGynzyNpmToken(ifClause=null, workingDirectory=null)::
    base.step(
      'set gynzy npm_token',
      run=
      |||
        cat <<EOF > .npmrc
        @gynzy:registry=https://npm.gynzy.net/
        "//npm.gynzy.net/:_authToken"="${NPM_TOKEN}"
        public-hoist-pattern[]=@pulumi/pulumi
        EOF
      |||,
      env={
        NPM_TOKEN: misc.secret('npm_token'),
      },
      ifClause=ifClause,
      workingDirectory=workingDirectory,
    ),

  /**
   * Creates a step to configure npm token for GitHub Package Registry.
   *
   * @param {string} [ifClause=null] - Conditional expression to determine if step should run
   * @param {string} [workingDirectory=null] - Directory to create .npmrc file in
   * @returns {steps} - Array containing a single step object
   */
  setGithubNpmToken(ifClause=null, workingDirectory=null)::
    base.step(
      'set github npm_token',
      run=
      |||
        cat <<EOF > .npmrc
        @gynzy:registry=https://npm.pkg.github.com
        //npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
        public-hoist-pattern[]=@pulumi/pulumi
        EOF
      |||,
      env={
        NODE_AUTH_TOKEN: misc.secret('GITHUB_TOKEN'),
      },
      ifClause=ifClause,
      workingDirectory=workingDirectory,
    ),

  /**
   * Creates a complete workflow combining checkout, npm token setup, cache fetching, and yarn install.
   *
   * @param {string} [cacheName=null] - Name of the cache to fetch/store yarn dependencies
   * @param {string} [ifClause=null] - Conditional expression to determine if steps should run
   * @param {boolean} [fullClone=false] - Whether to perform a full git clone or shallow clone
   * @param {string} [ref=null] - Git ref to checkout (branch, tag, or commit)
   * @param {boolean} [prod=false] - Whether to install only production dependencies
   * @param {string} [workingDirectory=null] - Directory to run operations in
   * @param {string} [source='gynzy'] - Registry source ('gynzy' or 'github')
   * @param {boolean} [ignoreEngines=false] - Whether to ignore engine version checks
   * @returns {steps} - Array of step objects for the complete workflow
   */
  checkoutAndYarn(cacheName=null, ifClause=null, fullClone=false, ref=null, prod=false, workingDirectory=null, source='gynzy', ignoreEngines=false)::
    misc.checkout(ifClause=ifClause, fullClone=fullClone, ref=ref) +
    (if source == 'gynzy' then self.setGynzyNpmToken(ifClause=ifClause, workingDirectory=workingDirectory) else []) +
    (if source == 'github' then self.setGithubNpmToken(ifClause=ifClause, workingDirectory=workingDirectory) else []) +
    (if cacheName == null then [] else self.fetchYarnCache(cacheName, ifClause=ifClause, workingDirectory=workingDirectory)) +
    self.yarn(ifClause=ifClause, prod=prod, workingDirectory=workingDirectory, ignoreEngines=ignoreEngines),

  /**
   * Creates steps to fetch yarn cache from cloud storage.
   *
   * @param {string} cacheName - Name of the cache to fetch
   * @param {string} [ifClause=null] - Conditional expression to determine if step should run
   * @param {string} [workingDirectory=null] - Directory to extract cache to
   * @returns {steps} - Array of step objects for cache fetching
   */
  fetchYarnCache(cacheName, ifClause=null, workingDirectory=null)::
    cache.fetchCache(
      cacheName=cacheName,
      folders=['.yarncache'],
      additionalCleanupCommands=["find . -type d -name 'node_modules' | xargs rm -rf"],
      ifClause=ifClause,
      workingDirectory=workingDirectory
    ),

  /**
   * Creates a complete pipeline to update yarn cache on production deployments.
   *
   * @param {string} cacheName - Name of the cache to update
   * @param {string} [appsDir='packages'] - Directory containing applications with node_modules
   * @param {string} [image=null] - Docker image to use for the job
   * @param {boolean} [useCredentials=null] - Whether to use Docker registry credentials
   * @param {boolean} [ignoreEngines=false] - Whether to ignore engine version checks
   * @returns {workflows} - Complete GitHub Actions pipeline configuration
   */
  updateYarnCachePipeline(cacheName, appsDir='packages', image=null, useCredentials=null, ignoreEngines=false)::
    base.pipeline(
      'update-yarn-cache',
      [
        base.ghJob(
          'update-yarn-cache',
          image=image,
          useCredentials=useCredentials,
          ifClause="${{ github.event.deployment.environment == 'production' || github.event.deployment.environment == 'prod' }}",
          steps=[
            misc.checkout() +
            self.setGynzyNpmToken() +
            self.yarn(ignoreEngines=ignoreEngines),
            base.action(
              'setup auth',
              'google-github-actions/auth@v2',
              with={
                credentials_json: misc.secret('SERVICE_JSON'),
              },
              id='auth',
            ),
            base.action('setup-gcloud', 'google-github-actions/setup-gcloud@v2'),
            cache.uploadCache(
              cacheName=cacheName,
              tarCommand='ls "' + appsDir + '/*/node_modules" -1 -d 2>/dev/null | xargs tar -c .yarncache node_modules',
            ),
          ],
        ),
      ],
      event='deployment',
    ),

  /**
   * Creates a step to publish a package to npm registry with version handling.
   *
   * @param {boolean} [isPr=true] - Whether this is a PR build (affects versioning)
   * @param {string} [ifClause=null] - Conditional expression to determine if step should run
   * @returns {steps} - Array containing a single step object
   */
  yarnPublish(isPr=true, ifClause=null)::
    base.step(
      'publish',
      |||
        bash -c 'set -xeo pipefail;

        cp package.json package.json.bak;

        VERSION=$(yarn version --non-interactive 2>/dev/null | grep "Current version" | grep -o -P '[0-9a-zA-Z_.-]+$' );
        if [[ ! -z "${PR_NUMBER}" ]]; then
          echo "Setting tag/version for pr build.";
          TAG=pr-$PR_NUMBER;
          PUBLISHVERSION="$VERSION-pr$PR_NUMBER.$GITHUB_RUN_NUMBER";
        elif [[ "${GITHUB_REF_TYPE}" == "tag" ]]; then
          if [[ "${GITHUB_REF_NAME}" != "${VERSION}" ]]; then
            echo "Tag version does not match package version. They should match. Exiting";
            exit 1;
          fi
          echo "Setting tag/version for release/tag build.";
          PUBLISHVERSION=$VERSION;
          TAG="latest";
        elif [[ "${GITHUB_REF_TYPE}" == "branch" && ( "${GITHUB_REF_NAME}" == "main" || "${GITHUB_REF_NAME}" == "master" ) ]] || [[ "${GITHUB_EVENT_NAME}" == "deployment" ]]; then
          echo "Setting tag/version for release/tag build.";
          PUBLISHVERSION=$VERSION;
          TAG="latest";
        else
          exit 1
        fi

        yarn publish --non-interactive --no-git-tag-version --tag "$TAG" --new-version "$PUBLISHVERSION";

        mv package.json.bak package.json;
        ';
      |||,
      env={} + (if isPr then { PR_NUMBER: '${{ github.event.number }}' } else {}),
      ifClause=ifClause,
    ),

  /**
   * Creates steps to publish a package to multiple repositories.
   *
   * @param {boolean} isPr - Whether this is a PR build (affects versioning)
   * @param {array} repositories - List of repository types ('gynzy' or 'github')
   * @param {string} [ifClause=null] - Conditional expression to determine if steps should run
   * @returns {steps} - Array of step objects for publishing to all repositories
   */
  yarnPublishToRepositories(isPr, repositories, ifClause=null)::
    (std.flatMap(function(repository)
                   if repository == 'gynzy' then [self.setGynzyNpmToken(ifClause=ifClause), self.yarnPublish(isPr=isPr, ifClause=ifClause)]
                   else if repository == 'github' then [self.setGithubNpmToken(ifClause=ifClause), self.yarnPublish(isPr=isPr, ifClause=ifClause)]
                   else error 'Unknown repository type given.',
                 repositories)),


  /**
   * Creates a GitHub Actions job for publishing preview packages from PRs.
   *
   * @param {string} [image='mirror.gcr.io/node:22'] - Docker image to use for the job
   * @param {boolean} [useCredentials=false] - Whether to use Docker registry credentials
   * @param {string} [gitCloneRef='${{ github.event.pull_request.head.sha }}'] - Git reference to checkout
   * @param {array} [buildSteps=[base.step('build', 'yarn build')]] - Build steps to run before publishing
   * @param {boolean} [checkVersionBump=true] - Whether to check if package version was bumped
   * @param {array} [repositories=['gynzy']] - List of repositories to publish to
   * @param {boolean|string} [onChangedFiles=false] - Whether to only run on changed files (or glob pattern)
   * @param {string} [changedFilesHeadRef=null] - Head reference for changed files comparison
   * @param {string} [changedFilesBaseRef=null] - Base reference for changed files comparison
   * @param {string} [runsOn=null] - Runner type to use
   * @returns {jobs} - GitHub Actions job definition
   */
  yarnPublishPreviewJob(
    image='mirror.gcr.io/node:22',
    useCredentials=false,
    gitCloneRef='${{ github.event.pull_request.head.sha }}',
    buildSteps=[base.step('build', 'yarn build')],
    checkVersionBump=true,
    repositories=['gynzy'],
    onChangedFiles=false,
    changedFilesHeadRef=null,
    changedFilesBaseRef=null,
    runsOn=null,
  )::
    local ifClause = (if onChangedFiles != false then "steps.changes.outputs.package == 'true'" else null);
    base.ghJob(
      'yarn-publish-preview',
      runsOn=runsOn,
      image='mirror.gcr.io/node:22',
      useCredentials=false,
      steps=
      [self.checkoutAndYarn(ref=gitCloneRef, fullClone=false)] +
      (if onChangedFiles != false then misc.testForChangedFiles({ package: onChangedFiles }, headRef=changedFilesHeadRef, baseRef=changedFilesBaseRef) else []) +
      (if checkVersionBump then [
         base.action('check-version-bump', uses='del-systems/check-if-version-bumped@v1', with={
           token: '${{ github.token }}',
         }, ifClause=ifClause),
       ] else []) +
      (if onChangedFiles != false then std.map(function(step) std.map(function(s) s { 'if': ifClause }, step), buildSteps) else buildSteps) +
      self.yarnPublishToRepositories(isPr=true, repositories=repositories, ifClause=ifClause),
      permissions={ packages: 'write', contents: 'read', 'pull-requests': 'read' },
    ),

  /**
   * Creates a GitHub Actions job for publishing packages from main branch or releases.
   *
   * @param {string} [image='mirror.gcr.io/node:22'] - Docker image to use for the job
   * @param {boolean} [useCredentials=false] - Whether to use Docker registry credentials
   * @param {string} [gitCloneRef='${{ github.sha }}'] - Git reference to checkout
   * @param {array} [buildSteps=[base.step('build', 'yarn build')]] - Build steps to run before publishing
   * @param {array} [repositories=['gynzy']] - List of repositories to publish to
   * @param {boolean|string} [onChangedFiles=false] - Whether to only run on changed files (or glob pattern)
   * @param {string} [changedFilesHeadRef=null] - Head reference for changed files comparison
   * @param {string} [changedFilesBaseRef=null] - Base reference for changed files comparison
   * @param {string} [ifClause=null] - Conditional expression to determine if job should run
   * @param {string} [runsOn=null] - Runner type to use
   * @returns {jobs} - GitHub Actions job definition
   */
  yarnPublishJob(
    image='mirror.gcr.io/node:22',
    useCredentials=false,
    gitCloneRef='${{ github.sha }}',
    buildSteps=[base.step('build', 'yarn build')],
    repositories=['gynzy'],
    onChangedFiles=false,
    changedFilesHeadRef=null,
    changedFilesBaseRef=null,
    ifClause=null,
    runsOn=null,
  )::
    local stepIfClause = (if onChangedFiles != false then "steps.changes.outputs.package == 'true'" else null);
    base.ghJob(
      'yarn-publish',
      image='mirror.gcr.io/node:22',
      runsOn=runsOn,
      useCredentials=false,
      steps=
      [self.checkoutAndYarn(ref=gitCloneRef, fullClone=false)] +
      (if onChangedFiles != false then misc.testForChangedFiles({ package: onChangedFiles }, headRef=changedFilesHeadRef, baseRef=changedFilesBaseRef) else []) +
      (if onChangedFiles != false then std.map(function(step) std.map(function(s) s { 'if': stepIfClause }, step), buildSteps) else buildSteps) +
      self.yarnPublishToRepositories(isPr=false, repositories=repositories, ifClause=stepIfClause),
      permissions={ packages: 'write', contents: 'read', 'pull-requests': 'read' },
      ifClause=ifClause,
    ),
}
