local base = import 'base.jsonnet';
local images = import 'images.jsonnet';

{
  /**
   * Creates steps to check out repository code with intelligent SSH/HTTPS fallback.
   *
   * First attempts SSH checkout (if enabled), then falls back to HTTPS if SSH fails.
   * Automatically installs git/ssh binaries if needed using system (apt/apk) package manager.
   *
   * @param {string} [ifClause=null] - Conditional expression for step execution
   * @param {boolean} [fullClone=false] - Whether to perform full git clone (fetch-depth: 0)
   * @param {string} [ref=null] - Specific git ref/branch/tag to checkout
   * @param {boolean} [preferSshClone=true] - Whether to attempt SSH clone first
   * @param {boolean} [includeSubmodules=true] - Whether to checkout git submodules
   * @returns {steps} - GitHub Actions steps for repository checkout
   */
  checkout(ifClause=null, fullClone=false, ref=null, preferSshClone=true, includeSubmodules=true)::
    local with =
      (if fullClone then { 'fetch-depth': 0 } else {}) +
      (if ref != null then { ref: ref } else {}) +
      (if includeSubmodules then { submodules: 'recursive' } else {});
    local sshSteps = (if (preferSshClone) then
                        base.step(
                          'check for ssh/git binaries',
                          |||
                            if command -v git;
                              then
                                echo "gitBinaryExists=true" >> $GITHUB_OUTPUT;
                                echo "Git binary exists";
                              else
                                echo "Attempt to install git binary";
                                if command -v apk; then
                                  echo "apk exists";
                                  apk add git && echo "gitBinaryExists=true" >> $GITHUB_OUTPUT;
                                elif command -v apt; then
                                  echo "apt exists";
                                  apt update && apt install -y git && echo "gitBinaryExists=true" >> $GITHUB_OUTPUT;
                                else
                                  echo "No package manager found, unable to install git cli binary";
                                  echo "gitBinaryExists=false" >> $GITHUB_OUTPUT;
                                fi;
                            fi;

                            if command -v ssh;
                              then
                                echo "sshBinaryExists=true" >> $GITHUB_OUTPUT;
                                echo "SSH binary exists";
                                exit 0;
                              else
                                echo "Attempt to install ssh binary";
                                if command -v apk; then
                                  echo "apk exists";
                                  apk add openssh-client && echo "sshBinaryExists=true" >> $GITHUB_OUTPUT && exit 0;
                                elif command -v apt; then
                                  echo "apt exists";
                                  apt update && apt install -y openssh-client && echo "sshBinaryExists=true" >> $GITHUB_OUTPUT && exit 0;
                                else
                                  echo "No package manager found, unable to install ssh cli binary";
                                  echo "sshBinaryExists=false" >> $GITHUB_OUTPUT;
                                fi;
                            fi;
                            echo "sshBinaryExists=false" >> $GITHUB_OUTPUT;
                          |||,
                          id='check-binaries',
                        ) else []);

    // strip the ${{ }} from the IfClause so we can inject and add our own if clause
    local localIfClause = (if ifClause == null then null else std.strReplace(std.strReplace(ifClause, '${{ ', ''), ' }}', ''));

    if (preferSshClone) then
      sshSteps +
      base.action(
        'Check out repository code via ssh',
        'actions/checkout@v4',
        with=with + (if preferSshClone then { 'ssh-key': '${{ secrets.VIRKO_GITHUB_SSH_KEY }}' } else {}),
        ifClause='${{ ' + (if ifClause == null then '' else '( ' + localIfClause + ' ) && ') + " ( steps.check-binaries.outputs.sshBinaryExists == 'true' && steps.check-binaries.outputs.gitBinaryExists == 'true' ) }}",
      ) +
      base.action(
        'Check out repository code via https',
        'actions/checkout@v4',
        with=with,
        ifClause='${{ ' + (if ifClause == null then '' else '( ' + localIfClause + ' ) && ') + " ( steps.check-binaries.outputs.sshBinaryExists == 'false' || steps.check-binaries.outputs.gitBinaryExists == 'false' ) }}",
      ) +
      base.step('git safe directory', "command -v git && git config --global --add safe.directory '*' || true")
    else
      self.checkoutWithoutSshMagic(ifClause, fullClone, ref),

  /**
   * Creates a simple repository checkout without SSH fallback logic.
   *
   * @param {string} [ifClause=null] - Conditional expression for step execution
   * @param {boolean} [fullClone=false] - Whether to perform full git clone (fetch-depth: 0)
   * @param {string} [ref=null] - Specific git ref/branch/tag to checkout
   * @param {boolean} [includeSubmodules=true] - Whether to checkout git submodules
   * @returns {steps} - GitHub Actions steps for basic repository checkout
   */
  checkoutWithoutSshMagic(ifClause=null, fullClone=false, ref=null, includeSubmodules=true)::
    local with =
      (if fullClone then { 'fetch-depth': 0 } else {}) +
      (if ref != null then { ref: ref } else {}) +
      (if includeSubmodules then { submodules: 'recursive' } else {});
    base.action(
      'Check out repository code',
      'actions/checkout@v4',
      with=with,
      ifClause=ifClause
    ) +
    base.step('git safe directory', "command -v git && git config --global --add safe.directory '*' || true"),

  /**
   * Creates a linting step for a specific service using ESLint.
   *
   * @param {string} service - Name of the service to lint
   * @returns {steps} - GitHub Actions step to run ESLint on service files
   */
  lint(service)::
    base.step('lint-' + service,
              './node_modules/.bin/eslint "./packages/' + service + '/{app,lib,tests,config,addon}/**/*.js" --quiet'),

  /**
   * Creates a step to lint all code using yarn lint command.
   *
   * @returns {steps} - GitHub Actions step to run yarn lint
   */
  lintAll()::
    base.step('lint', 'yarn lint'),

  /**
   * Creates a step to verify good-fences architectural boundaries.
   *
   * @returns {steps} - GitHub Actions step to run good-fences verification
   */
  verifyGoodFences()::
    base.step('verify-good-fences', 'pnpm run gf'),

  /**
   * Creates a step to run improved npm audit for security vulnerabilities.
   *
   * @returns {steps} - GitHub Actions step to run yarn improved-audit
   */
  improvedAudit()::
    base.step('audit', 'yarn improved-audit'),

  /**
   * Creates a complete pipeline to verify jsonnet workflow generation.
   *
   * @returns {workflows} - GitHub Actions pipeline that validates jsonnet workflows on pull requests
   */
  verifyJsonnetWorkflow()::
    base.pipeline(
      'misc',
      [
        self.verifyJsonnet(fetch_upstream=false),
      ],
      event='pull_request',
    ),

  /**
   * Creates a GitHub Actions job to verify that jsonnet files generate correct workflows.
   *
   * @param {boolean} [fetch_upstream=false] - Whether to fetch the latest lib-jsonnet from upstream (deprecated)
   * @param {string} [runsOn=null] - Runner type to use for the job
   * @returns {jobs} - GitHub Actions job that validates jsonnet workflow generation
   */
  verifyJsonnet(fetch_upstream=false, runsOn=null)::
    base.ghJob(
      'verify-jsonnet-gh-actions',
      runsOn=runsOn,
      image=images.jsonnet_bin_image,
      steps=[
              self.checkout(ref='${{ github.event.pull_request.head.sha }}'),
              base.step('remove-workflows', 'rm -f .github/workflows/*'),
            ] +
            (
              if fetch_upstream then [base.step('fetch latest lib-jsonnet',
                                                ' rm -rf .github/jsonnet/;\n                mkdir .github/jsonnet/;\n                cd .github;\n                curl https://files.gynzy.net/lib-jsonnet/v1/jsonnet-prod.tar.gz | tar xvzf -;\n              ')] else []
            )
            + [
              base.step('generate-workflows', 'jsonnet -m .github/workflows/ -S .github.jsonnet;'),
              base.step('git workaround', 'git config --global --add safe.directory $PWD'),
              base.step(
                'check-jsonnet-diff', |||
                  echo "If this step fails, look at the end of the logs for possible causes";
                  git diff --exit-code && exit 0;
                  echo "Error: mismatch between jsonnet <-> github workflows";
                  echo "Possible reasons:";
                  echo " - You updated jsonnet files, but did not regenerate the workflows.";
                  echo "   To regenerate jsonnet run: 'rm .github/workflows/*; jsonnet -m .github/workflows/ -S .github.jsonnet'";
                  echo " - You used the wrong jsonnet binary. In this case, the newlines at the end of the files differ.";
                  echo "   To fix, install the go binary. On mac, run 'brew uninstall jsonnet && brew install go-jsonnet'";
                  exit 1;
                |||
              ),
            ],
    ),

  /**
   * Creates a pipeline to automatically update PR descriptions and titles based on templates.
   *
   * @param {string} bodyTemplate - Template for the PR body content
   * @param {string} [titleTemplate=''] - Template for the PR title
   * @param {string} [baseBranchRegex=null] - Regex to match base branch names
   * @param {string} [headBranchRegex=null] - Regex to match head branch names
   * @param {string} [bodyUpdateAction='suffix'] - How to update the body ('suffix', 'prefix', 'replace')
   * @param {string} [titleUpdateAction='prefix'] - How to update the title ('suffix', 'prefix', 'replace')
   * @param {object} [otherOptions={}] - Additional options to pass to the action
   * @returns {workflows} - GitHub Actions pipeline for automatic PR description updates
   */
  updatePRDescriptionPipeline(
    bodyTemplate,
    titleTemplate='',
    baseBranchRegex=null,
    headBranchRegex=null,
    bodyUpdateAction='suffix',
    titleUpdateAction='prefix',
    otherOptions={},
  )::
    base.pipeline(
      'update-pr-description',
      event={
        pull_request: { types: ['opened'] },
      },
      jobs=[
        base.ghJob(
          'update-pr-description',
          steps=[
            base.action(
              'update-pr-description',
              'gynzy/pr-update-action@v2',
              with={
                'repo-token': '${{ secrets.GITHUB_TOKEN }}',
                [if baseBranchRegex != null then 'base-branch-regex']: baseBranchRegex,
                [if headBranchRegex != null then 'head-branch-regex']: headBranchRegex,
                'title-template': titleTemplate,
                'body-template': bodyTemplate,
                'body-update-action': bodyUpdateAction,
                'title-update-action': titleUpdateAction,
              } + otherOptions,
            ),
          ],
          useCredentials=false,
        ),
      ],
      permissions={
        'pull-requests': 'write',
      },
    ),

  /**
   * Generates a markdown table from headers and rows data.
   *
   * The headers array and each row array must have the same length.
   *
   * @param {array} headers - Array of column header strings
   * @param {array} rows - Array of row data (each row is an array of cell values)
   * @returns {string} - Formatted markdown table
   */
  markdownTable(headers, rows)::
    local renderLine = function(line) '| ' + std.join(' | ', line) + ' |\n';
    local renderedHeader = renderLine(headers) + renderLine(std.map(function(x) '---', headers));

    local renderedRows = std.map(
      function(line)
        assert std.length(headers) == std.length(line) : 'Headers and rows must have the same length';
        renderLine(line),
      rows
    );
    renderedHeader + std.join('', renderedRows),

  /**
   * Creates a collapsible markdown section using HTML details/summary tags.
   *
   * @param {string} title - Title text for the collapsible section
   * @param {string} content - Content to display when expanded
   * @returns {string} - HTML details element with markdown content
   */
  markdownCollapsable(title, content)::
    '<details>\n' +
    '<summary>' + title + '</summary>\n\n' +
    content + '\n' +
    '</details>\n',

  /**
   * Creates a markdown table with preview links for different environments.
   *
   * @param {array} environments - Array of environment names
   * @param {array} apps - Array of app objects with the following fields:
   *   - name: The name of the app
   *   - linkToLinear: Array of environment names for which to create preview links in Linear
   *   - [environment]: The environment links (key is environment name, value is link or object with multiple links)
   * @returns {string} - Markdown table with preview links and collapsible Linear links section
   *
   * @example
   * misc.previewLinksTable(
   *   ['pr', 'acceptance', 'test', 'prod'],
   *   [
   *     {
   *       name: 'app1',
   *       pr: 'https://pr-link',
   *       acceptance: 'https://acceptance-link',
   *       test: 'https://test-link',
   *       prod: 'https://prod-link',
   *     },
   *     {
   *       name: 'app2',
   *       linkToLinear: ['pr', 'acceptance'],
   *       pr: 'https://pr-link',
   *       acceptance: 'https://acceptance-link',
   *       test: 'https://test-link',
   *       prod: {
   *         'prod-nl': 'https://prod-link/nl',
   *         'prod-en': 'https://prod-link/en',
   *       },
   *     },
   *   ],
   * )
   */
  previewLinksTable(environments, apps)::
    local headers = ['Application'] + environments;
    local rows = std.map(
      function(app)
        [app.name] + std.map(
          function(env)
            if !std.objectHas(app, env) then
              '-'
            else
              local link = app[env];
              if std.isObject(link) then
                std.join(' - ', std.map(function(linkName) '[' + linkName + '](' + link[linkName] + ')', std.objectFields(link)))
              else
                '[' + env + '](' + link + ')',
          environments
        )
      ,
      apps
    );
    local linearLinks = std.flatMap(
      function(app) std.flatMap(
        function(env)
          if std.isObject(app[env]) then
            std.map(
              function(linkName)
                '[' + std.strReplace(std.strReplace(app.name + ' ' + env + ' ' + linkName, '(', ''), ')', '') + ' preview]' +
                '(' + app[env][linkName] + ')',
              std.objectFields(app[env])
            )
          else
            ['[' + std.strReplace(std.strReplace(app.name + ' ' + env, '(', ''), ')', '') + ' preview](' + app[env] + ')'],

        app.linkToLinear,
      ),
      std.filter(function(app) std.objectHas(app, 'linkToLinear'), apps)
    );
    self.markdownTable(headers, rows) + self.markdownCollapsable('Linear links', std.join('\n', linearLinks)),

  /**
   * Creates a shortened service name by removing common prefixes.
   *
   * @param {string} name - Full service name
   * @returns {string} - Shortened service name without 'service-' prefix
   */
  shortServiceName(name)::
    assert name != null;
    std.strReplace(std.strReplace(name, 'gynzy-', ''), 'unicorn-', ''),

  /**
   * Creates a reference to a GitHub repository secret.
   *
   * @param {string} secretName - Name of the secret in GitHub repository settings
   * @returns {string} - GitHub Actions expression to access the secret
   */
  secret(secretName)::
    '${{ secrets.' + secretName + ' }}',

  /**
   * Creates a step to poll a URL until it returns expected content.
   *
   * Useful for verifying that deployments are healthy and serving correct content.
   *
   * @param {string} url - URL to poll for content verification
   * @param {string} expectedContent - Content expected to be found in the response
   * @param {string} [name='verify-deploy'] - Name of the verification step
   * @param {string} [attempts='100'] - Maximum number of polling attempts
   * @param {string} [interval='2000'] - Interval between attempts in milliseconds
   * @param {string} [ifClause=null] - Conditional expression for step execution
   * @returns {steps} - GitHub Actions step that polls URL until content matches
   */
  pollUrlForContent(url, expectedContent, name='verify-deploy', attempts='100', interval='2000', ifClause=null)::
    base.action(
      name,
      'gynzy/wait-for-http-content@v1',
      with={
        url: url,
        expectedContent: expectedContent,
        attempts: attempts,
        interval: interval,
      },
      ifClause=ifClause,
    ),

  /**
   * Creates a scheduled pipeline to automatically clean up old branches.
   *
   * Runs weekly on Monday at 12:00 UTC to remove branches older than 3 months.
   *
   * @param {string} [protectedBranchRegex='^(main|master|gynzy|upstream)$'] - Regex pattern for branches to protect from deletion
   * @returns {workflows} - GitHub Actions pipeline scheduled to clean up old branches
   */
  cleanupOldBranchesPipelineCron(protectedBranchRegex='^(main|master|gynzy|upstream)$')::
    base.pipeline(
      'purge-old-branches',
      [
        base.ghJob(
          'purge-old-branches',
          useCredentials=false,
          image=null,
          runsOn='ubuntu-latest',
          steps=[
            base.action('checkout', 'actions/checkout@v4'),
            base.action(
              'Run delete-old-branches-action',
              'beatlabs/delete-old-branches-action@4eeeb8740ff8b3cb310296ddd6b43c3387734588',
              with={
                repo_token: '${{ github.token }}',
                date: '3 months ago',
                dry_run: false,
                delete_tags: false,
                extra_protected_branch_regex: protectedBranchRegex,
                extra_protected_tag_regex: '^v.*',
                exclude_open_pr_branches: true,
              },
              env={
                GIT_DISCOVERY_ACROSS_FILESYSTEM: 'true',
              }
            ),
          ],
        ),
      ],
      event={
        schedule: [{ cron: '0 12 * * 1' }],
      },
    ),

  /**
   * Creates a step to test if changed files match the given glob patterns.
   *
   * Can test for multiple pattern groups and sets multiple outputs.
   * Requires the 'pull-requests': 'read' permission.
   *
   * @param {object} changedFiles - Map of grouped glob patterns to test against
   *   - Key: Name of the group
   *   - Value: Array of glob patterns (can use * and **) to test against
   * @param {string} [headRef=null] - Head commit reference (defaults to current)
   * @param {string} [baseRef=null] - Base commit reference (defaults to target branch)
   * @returns {steps} - GitHub Actions step that sets outputs: steps.changes.outputs.<group>
   *
   * @example
   * misc.testForChangedFiles({
   *   'app': ['packages/star/app/doublestar/star', 'package.json'],
   *   'lib': ['packages/star/lib/doublestar/star'],
   * })
   *
   * // This sets outputs that can be tested in if clauses:
   * // if: steps.changes.outputs.app == 'true'
   *
   * // Note: Replace 'star' with '*' and 'doublestar' with '**' in actual usage
   * // See https://github.com/dorny/paths-filter for more information.
   */
  testForChangedFiles(changedFiles, headRef=null, baseRef=null)::
    [
      base.step('git safe directory', 'git config --global --add safe.directory $PWD'),
      base.action(
        'check-for-changes',
        uses='dorny/paths-filter@v2',
        id='changes',
        with={
               filters: |||
                 %s
               ||| % std.manifestYamlDoc(changedFiles),
               token: '${{ github.token }}',
             } +
             (if headRef != null then { ref: headRef } else {}) +
             (if baseRef != null then { base: baseRef } else {}),
      ),
    ],

  /**
   * Creates a job that waits for given jobs to finish.
   *
   * Exits successfully if all jobs are successful, otherwise exits with an error.
   *
   * @param {string} name - The name of the GitHub job
   * @param {array} jobs - Array of job objects to wait for
   * @returns {jobs} - GitHub Actions job that waits for the given jobs to finish
   */
  awaitJob(name, jobs)::
    local dependingJobs = std.flatMap(
      function(job)
        local jobNameArray = std.objectFields(job);
        if std.length(jobNameArray) == 1 then [jobNameArray[0]] else [],
      jobs
    );
    [
      base.ghJob(
        'await-' + name,
        ifClause='${{ always() }}',
        needs=dependingJobs,
        useCredentials=false,
        steps=[
          base.step(
            'success',
            'exit 0',
            ifClause="${{ contains(join(needs.*.result, ','), 'success') }}"
          ),
          base.step(
            'failure',
            'exit 1',
            ifClause="${{ contains(join(needs.*.result, ','), 'failure') }}"
          ),
        ],
      ),
    ],

  /**
   * Creates a Kubernetes job that runs a container with specified resources.
   *
   * @param {string} name - Display name for the GitHub Actions step
   * @param {string} jobName - Kubernetes job name (must be unique)
   * @param {object} cluster - Target Kubernetes cluster configuration
   * @param {string} image - Docker image to run in the job
   * @param {object} environment - Environment variables for the container
   * @param {string} [command=''] - Command to run in the container
   * @param {string} [ifClause=null] - Conditional expression for step execution
   * @param {string} [memory='100Mi'] - Memory request for the container
   * @param {string} [memoryLimit='100Mi'] - Memory limit for the container
   * @param {string} [cpu='100m'] - CPU request for the container
   * @param {string} [cpuLimit='100m'] - CPU limit for the container
   * @returns {steps} - GitHub Actions step that creates and monitors Kubernetes job
   */
  postJob(name, jobName, cluster, image, environment, command='', ifClause=null, memory='100Mi', memoryLimit='100Mi', cpu='100m', cpuLimit='100m')::
    base.action(
      name,
      'docker://' + images.job_poster_image,
      ifClause=ifClause,
      env={
        JOB_NAME: jobName,
        IMAGE: image,
        COMMAND: command,
        ENVIRONMENT: std.join(' ', std.objectFields(environment)),
        GCE_JSON: cluster.secret,
        GKE_PROJECT: cluster.project,
        GKE_ZONE: cluster.zone,
        GKE_CLUSTER: cluster.name,
        NODESELECTOR_KEY: cluster.jobNodeSelectorKey,
        NODESELECTOR_VALUE: cluster.jobNodeSelectorValue,
        JOB_REQUEST_MEM: memory,
        JOB_REQUEST_MEM_LIMIT: memoryLimit,
        JOB_REQUEST_CPU: cpu,
        JOB_REQUEST_CPU_LIMIT: cpuLimit,
      } + environment,
    ),

  /**
   * Creates a pipeline to auto-approve PRs made by specific users.
   *
   * Useful for automatically approving renovate PRs or other trusted automation.
   *
   * @param {array} [users=['gynzy-virko']] - Array of usernames to auto-approve PRs for
   * @returns {workflows} - GitHub Actions pipeline that auto-approves PRs from specified users
   */
  autoApprovePRs(users=['gynzy-virko'])::
    base.pipeline(
      'auto-approve-prs',
      [
        base.ghJob(
          'auto-approve',
          steps=[
            base.action(
              'auto-approve-prs',
              'hmarr/auto-approve-action@v4',
            ),
          ],
          useCredentials=false,
          ifClause='${{ ' + std.join(' || ', std.map(function(user) "github.actor == '" + user + "'", users)) + ' }}',
        ),
      ],
      permissions={
        'pull-requests': 'write',
      },
      event={
        pull_request: { types: ['opened'] },
      },
    ),

  /**
   * Creates a step to obtain a mutex lock for mutual exclusion within a repository.
   *
   * Most commonly used to gate Pulumi since it does its own locking but does not wait for the lock.
   *
   * @param {string} [lockName='lock'] - The name of the lock (branch used for locking)
   * @param {string} [lockTimeout='1200'] - How long to wait for the lock in seconds (defaults to 20 minutes)
   * @returns {steps} - GitHub Actions step that acquires a mutex lock
   */
  getLockStep(
    lockName='lock',
    lockTimeout='1200',  // seconds
  )::
    base.action(
      'get mutex lock',
      'gynzy/gh-action-mutex@main',
      with={
        branch: lockName,
        timeout: lockTimeout,
      },
    ),

  /**
   * Creates a step to install the 1Password CLI tool.
   *
   * @param {string} [version='v2.31.1'] - Version of the 1Password CLI to install
   * @returns {steps} - GitHub Actions step that installs 1Password CLI
   */
  install1Password(
    version='v2.31.1',
  )::
    base.step(
      'Install 1Password CLI',
      |||
        OP_INSTALL_DIR="$(mktemp -d)"
        curl -sSfLo op.zip "https://cache.agilebits.com/dist/1P/op2/pkg/${OP_CLI_VERSION}/op_linux_${ARCH}_${OP_CLI_VERSION}.zip"
        unzip -od "$OP_INSTALL_DIR" op.zip && rm op.zip
        echo "$OP_INSTALL_DIR" >> "$GITHUB_PATH"
      |||,
      env={
        OP_CLI_VERSION: version,
        ARCH: 'amd64',
      }
    ),

  /**
   * Creates a step to configure Google Cloud authentication.
   * Also configures Docker registry access.
   *
   * @param {string} secret - Google Cloud service account JSON secret
   * @returns {steps} - Array containing a single step object
   */
  configureGoogleAuth(secret)::
    base.step(
      'activate google service account',
      run=
      |||
        printf '%s' "${SERVICE_JSON}" > gce.json;
        gcloud auth activate-service-account --key-file=gce.json;
        gcloud --quiet auth configure-docker;
        rm gce.json
      |||,
      env={ SERVICE_JSON: secret },
    ),

  /**
   * Creates a scheduled workflow to automatically close stale pull requests.
   *
   * PRs are marked as stale after a period of inactivity, and closed if they remain inactive.
   * The stale label is automatically removed when a PR is updated.
   *
   * @param {number} [daysBeforeStale=60] - Days of inactivity before marking a PR as stale
   * @param {number} [daysBeforeClose=7] - Days after being marked stale before closing the PR
   * @param {array} [exemptLabels=['long-lived']] - Labels that exempt PRs from being marked stale
   * @param {boolean} [exemptDraftPr=false] - Whether to exempt draft PRs from being marked stale
   * @param {string} [staleLabel='stale'] - Label to apply when marking a PR as stale
   * @param {string} [stalePrMessage=null] - Custom message when marking PR as stale (uses default if null)
   * @param {string} [closePrMessage=null] - Custom message when closing PR (uses default if null)
   * @returns {workflows} - GitHub Actions workflow that runs daily to manage stale PRs
   */
  closeStalePullRequestsWorkflow(
    daysBeforeStale=60,
    daysBeforeClose=7,
    exemptLabels=['long-lived'],
    exemptDraftPr=false,
    staleLabel='stale',
    stalePrMessage='This pull request has been automatically marked as stale due to 60 days of inactivity. It will be closed in 7 days if no further activity occurs. If this PR is still relevant, ' +
      if (std.length(exemptLabels) == 0) then
        'please push a new commit or leave a comment to keep it open.'
      else if (std.length(exemptLabels) == 1) then
        'please push a new commit, leave a comment or add the `' + exemptLabels[0] + '` label to keep it open.'
      else
        'please push a new commit, leave a comment or add one of these labels to keep it open: `' + std.join('`, `', exemptLabels) + '`.',
    closePrMessage='This pull request has been automatically closed due to continued inactivity. Feel free to reopen it if work resumes.',
  )::
    base.pipeline(
      'close-stale-prs',
      [
        base.ghJob(
          'close-stale-prs',
          useCredentials=false,
          image=null,
          runsOn='ubuntu-latest',
          steps=[
            base.action(
              'Close stale PRs',
              'actions/stale@v10',
              with={
                'days-before-stale': daysBeforeStale,
                'days-before-close': daysBeforeClose,
                'stale-pr-label': staleLabel,
                'stale-pr-message': stalePrMessage,
                'close-pr-message': closePrMessage,
                'exempt-pr-labels': std.join(',', exemptLabels),
                'exempt-draft-pr': exemptDraftPr,
                // Only process PRs, not issues
                'days-before-issue-stale': -1,
                'days-before-issue-close': -1,
              },
            ),
          ],
        ),
      ],
      event={
        schedule: [{ cron: '0 6 * * *' }],
      },
      permissions={
        actions: 'write',
        issues: 'write',
        'pull-requests': 'write',
      },
    ),
}
