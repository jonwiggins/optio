local base = import 'base.jsonnet';
local misc = import 'misc.jsonnet';
local yarn = import 'yarn.jsonnet';

{
  /**
   * Creates a complete set of workflows for JavaScript package publishing and testing.
   *
   * Generates three pipelines:
   * 1. 'misc' - Jsonnet validation workflow
   * 2. 'publish-prod' - Production package publishing on branch push
   * 3. 'pr' - Pull request preview publishing and testing
   *
   * @param {array} [repositories=['gynzy']] - The repositories to publish to
   * @param {boolean} [isPublicFork=true] - Whether the repository is a public fork (affects runner selection)
   * @param {boolean} [checkVersionBump=true] - Whether to assert if the version was bumped (recommended)
   * @param {jobs} [testJob=null] - A job to be run during PR to assert tests. Can be an array of jobs
   * @param {string} [branch='main'] - The branch to run the publish-prod job on
   * @returns {workflows} - Complete set of GitHub Actions workflows for JavaScript package lifecycle
   */
  workflowJavascriptPackage(repositories=['gynzy'], isPublicFork=true, checkVersionBump=true, testJob=null, branch='main')::
    local runsOn = (if isPublicFork then 'ubuntu-latest' else null);

    base.pipeline(
      'misc',
      [misc.verifyJsonnet(fetch_upstream=false, runsOn=runsOn)],
    ) +
    base.pipeline(
      'publish-prod',
      [
        yarn.yarnPublishJob(repositories=repositories, runsOn=runsOn),
      ],
      event={ push: { branches: [branch] } },
    ) +
    base.pipeline(
      'pr',
      [
        yarn.yarnPublishPreviewJob(repositories=repositories, runsOn=runsOn, checkVersionBump=checkVersionBump),
      ] +
      (if testJob != null then
         [testJob]
       else [])
    ),
}
