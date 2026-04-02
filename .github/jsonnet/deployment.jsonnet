local base = import 'base.jsonnet';
local images = import 'images.jsonnet';
local misc = import 'misc.jsonnet';
local notifications = import 'notifications.jsonnet';

{
  /**
   * Internal function to assert that a merge SHA is the latest commit on a branch.
   *
   * Prevents creating a deployment event for a closed PR whose code is considered merged, but not the latest commit.
   * For a more detailed explanation see `masterMergeDeploymentEventHook()`.
   *
   * @param {string} branch - The target branch to check
   * @param {string} [sha='${{ github.sha }}'] - The SHA to verify
   * @param {string} [repository='${{ github.repository }}'] - The repository to check
   * @returns {steps} - GitHub Actions steps to verify merge SHA is latest
   * @private
   */
  _assertMergeShaIsLatestCommit(branch, sha='${{ github.sha }}', repository='${{ github.repository }}')::
    base.step('install jq curl', 'apk add --no-cache jq curl') +
    base.step(
      'assert merge sha is latest commit',
      |||
        HEAD_SHA=$(curl -L -H "Accept: application/vnd.github+json" -H "Authorization: Bearer ${GITHUB_TOKEN}" -H "X-GitHub-Api-Version: 2022-11-28" https://api.github.com/repos/${GITHUB_REPOSITORY}/branches/${TARGET_BRANCH} | jq -r .commit.sha);
        if [ ${HEAD_SHA} == ${PR_MERGE_COMMIT_SHA} ]; then
          echo "Merge sha is latest commit on branch ${TARGET_BRANCH}! HEAD_SHA: ${HEAD_SHA} PR_MERGE_COMMIT_SHA: ${PR_MERGE_COMMIT_SHA}";
          echo "CREATE_DEPLOY_EVENT=true" >> $GITHUB_OUTPUT
        else
          echo "Merge sha is not latest commit on branch ${TARGET_BRANCH}! HEAD_SHA: ${HEAD_SHA} PR_MERGE_COMMIT_SHA: ${PR_MERGE_COMMIT_SHA}";
          echo "CREATE_DEPLOY_EVENT=false" >> $GITHUB_OUTPUT
        fi
      |||,
      env={
        PR_MERGE_COMMIT_SHA: sha,
        GITHUB_REPOSITORY: repository,
        TARGET_BRANCH: branch,
        GITHUB_TOKEN: '${{ github.token }}',
      },
      id='assert-merge-sha-is-latest-commit',
    ),


  /**
   * Creates a production deployment event on PR close if all conditions are met.
   *
   * Conditions:
   * - The PR is merged
   * - The PR is merged into the default branch
   * - The merge SHA is the latest commit on the default branch
   *
   * This prevents deployments from being created in edge cases where:
   * - PR A is merged into PR B
   * - PR B is merged into the default branch
   * - Both PRs would create deploy events without this sanity check
   *
   * For more complex deployment scenarios, use the branchMergeDeploymentEventHook instead.
   *
   * @param {boolean} [deployToTest=false] - If true, a deployment event is also created for the test environment
   * @param {string} [prodBranch=null] - The branch to deploy to production. Defaults to the default branch of the repository, but can be set to a different release branch
   * @param {string} [testBranch=null] - The branch to deploy to test. Defaults to the default branch of the repository, but can be set to a different test branch
   * @param {array} [deployTargets=['production']] - Deploy targets to create deployment events for. These targets will trigger based on the configured prodBranch
   * @param {string} [runsOn=null] - The name of the runner to run this job on. Defaults to null, which means the default self-hosted runner will be used
   * @param {boolean} [notifyOnTestDeploy=false] - If true, a Slack message is sent when a test deployment is created
   * @returns {workflows} - GitHub Actions pipeline for deployment event creation on PR merge
   */
  masterMergeDeploymentEventHook(deployToTest=false, prodBranch=null, testBranch=null, deployTargets=['production'], runsOn=null, notifyOnTestDeploy=false)::
    local branches = [
      {
        branch: (if prodBranch != null then prodBranch else '_default_'),
        deployments: deployTargets,
        notifyOnDeploy: true,
      },
    ] + (if deployToTest then [
           {
             branch: (if testBranch != null then testBranch else '_default_'),
             deployments: ['test'],
             notifyOnDeploy: notifyOnTestDeploy,
           },
         ] else []);

    self.branchMergeDeploymentEventHook(branches, runsOn=runsOn),

  /**
   * Creates deployment events on PR close for multiple branches with different deployment targets.
   *
   * Conditions:
   * - The PR is merged
   * - The PR is merged into one of the configured branches
   * - The merge SHA is the latest commit on the target branch
   *
   * This prevents deployments from being created in edge cases where:
   * - PR A is merged into PR B
   * - PR B is merged into the target branch
   * - Both PRs would create deploy events without this sanity check
   *
   * @param {array} branches - Array of branch objects to create deployment events for
   * @param {string} branches[].branch - The branch to which the PR has to be merged. If '_default_' is used, the default branch of the repository is used
   * @param {array} branches[].deployments - The environments to deploy to (e.g., ['production', 'test'])
   * @param {boolean} branches[].notifyOnDeploy - If true, a Slack message is sent when a deployment is created
   * @param {string} [runsOn=null] - The name of the runner to run this job on. Defaults to null, which means the default self-hosted runner will be used
   * @returns {workflows} - GitHub Actions pipeline for deployment event creation on PR merge to multiple branches
   */
  branchMergeDeploymentEventHook(branches, runsOn=null)::
    base.pipeline(
      'create-merge-deployment',
      [
        (
          local branchName = if branch.branch == '_default_' then '${{ github.event.pull_request.base.repo.default_branch }}' else branch.branch;
          local branchNameForJob = if branch.branch == '_default_' then 'default-branch' else branch.branch;
          local branchNameInExpression = if branch.branch == '_default_' then 'github.event.pull_request.base.repo.default_branch' else "'" + branch.branch + "'";

          local ifClause = '${{ github.event.pull_request.base.ref == ' + branchNameInExpression + " && steps.assert-merge-sha-is-latest-commit.outputs.CREATE_DEPLOY_EVENT == 'true' }}";

          base.ghJob(
            'create-merge-deployment-' + branchNameForJob + '-to-' + std.join('-', branch.deployments),
            useCredentials=false,
            runsOn=runsOn,
            permissions={ deployments: 'write', contents: 'read' },
            ifClause='${{ github.event.pull_request.merged == true}}',
            steps=[self._assertMergeShaIsLatestCommit(branch=branchName)] +
                  std.map(
                    function(deploymentTarget)
                      base.action(
                        'publish-deploy-' + deploymentTarget + '-event',
                        'chrnorm/deployment-action@v2',
                        ifClause=ifClause,
                        with={
                          token: misc.secret('VIRKO_GITHUB_TOKEN'),
                          environment: deploymentTarget,
                          'auto-merge': 'false',
                          ref: '${{ github.event.pull_request.head.sha }}',
                          description: 'Auto deploy ' + deploymentTarget + ' on PR merge. pr: ${{ github.event.number }} ref: ${{ github.event.pull_request.head.sha }}',
                          payload: '{ "pr" : ${{ github.event.number }}, "branch": "${{ github.head_ref }}", "base_ref": "${{ github.event.pull_request.base.sha }}", "head_ref": "${{ github.event.pull_request.head.sha }}" }',
                        }
                      ),
                    branch.deployments,
                  ) +
                  (
                    if branch.notifyOnDeploy then
                      [
                        notifications.sendSlackMessage(
                          message='Deploy to ' + std.join(' and ', branch.deployments) + ' of <https://github.com/${{ github.repository }}/pull/${{ github.event.number }}|*PR ${{ github.event.number }}*> started!\nTitle: ${{ github.event.pull_request.title }}\nBranch: ${{ github.head_ref }}',
                          ifClause=ifClause,
                        ),
                      ]
                    else []
                  ),
          )
        )
        for branch in branches
      ],
      event={
        pull_request: {
          types: ['closed'],
        },
      },
    ),

  /**
   * Generate a GitHub ifClause for the provided deployment targets.
   *
   * @param {array} targets - Array of deployment target environment names
   * @returns {string} - GitHub Actions conditional expression that matches any of the provided targets
   */
  deploymentTargets(targets)::
    '${{ ' + std.join(' || ', std.map(function(target) "github.event.deployment.environment == '" + target + "'", targets)) + ' }}',

  /**
   * Creates a step to update deployment status (success/failure) based on the result from the current job
   *
   * @returns {jobs} - GitHub Actions step that updates deployment status
   */
  updateDeploymentStatus(status='${{ job.status }}')::
    base.action(
      'Update deployment status',
      'chrnorm/deployment-status@v2',
      with={
        state: status,
        ['deployment-id']: '${{ github.event.deployment.id }}',
        token: '${{ secrets.GITHUB_TOKEN }}',
      },
      ifClause='${{ always() }}',
    ),
}
