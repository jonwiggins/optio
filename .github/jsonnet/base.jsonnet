local images = import 'images.jsonnet';
local misc = import 'misc.jsonnet';

{
  /**
   * Creates a complete GitHub Actions workflow pipeline with multiple jobs.
   *
   * @param {string} name - The name of the workflow (becomes the .yml filename)
   * @param {array of jobs} jobs - Array of job objects (created with ghJob, ghExternalJob, etc.)
   * @param {array} [event=['pull_request']] - GitHub events that trigger this workflow
   * @param {object} [permissions=null] - Permissions for the workflow (e.g., {contents: 'read'})
   * @param {object} [concurrency=null] - Concurrency settings to limit parallel runs
   * @returns {workflows} - GitHub Actions YAML manifest
   */
  pipeline(name, jobs, event=['pull_request'], permissions=null, concurrency=null):: {
    [name + '.yml']:
      '# GENERATED with jsonnet - DO NOT EDIT MANUALLY\n' +
      std.manifestYamlDoc(
        {
          name: name,
          on: event,
          jobs: std.foldl(function(x, y) x + y, jobs, {}),
        } + (if permissions == null then {} else { permissions: permissions }) + (if concurrency == null then {} else { concurrency: concurrency }),
      ),
  },

  /**
   * Creates a GitHub Actions job that runs on a containerized runner.
   *
   * @param {string} name - The name of the job (used as the job key)
   * @param {number} [timeoutMinutes=30] - Maximum time in minutes before job is cancelled. Max value is 55, after which the runner is killed.
   * @param {string} [runsOn=null] - Runner type (defaults to 'arc-runner-2')
   * @param {string} [image=images.default_job_image] - Docker image to run the job in
   * @param {steps} [steps=[]] - Array of step objects (created with step() or action())
   * @param {string} [ifClause=null] - Conditional expression to determine if job should run
   * @param {array} [needs=null] - Array of job names this job depends on
   * @param {object} [outputs=null] - Job outputs available to dependent jobs
   * @param {boolean} [useCredentials=true] - Whether to use Docker registry credentials. Must be set to false for public images.
   * @param {object} [services=null] - Service containers to run alongside the job
   * @param {object} [permissions=null] - Job-level permissions (overrides workflow permissions)
   * @param {object} [concurrency=null] - Job-level concurrency settings
   * @param {boolean} [continueOnError=null] - Whether to continue workflow if job fails
   * @param {object} [env=null] - Environment variables for all steps in the job
   * @returns {jobs} - GitHub Actions job definition
   */
  ghJob(
    name,
    timeoutMinutes=30,
    runsOn=null,
    image=images.default_job_image,
    steps=[],
    ifClause=null,
    needs=null,
    outputs=null,
    useCredentials=true,
    services=null,
    permissions=null,
    concurrency=null,
    continueOnError=null,
    env=null,
  )::
    {
      [name]: {
                'timeout-minutes': timeoutMinutes,
                'runs-on': (if runsOn == null then 'arc-runner-2' else runsOn),
              } +
              (
                if image == null then {} else
                  {
                    container: {
                      image: image,
                    } + (if useCredentials then { credentials: { username: '_json_key', password: misc.secret('docker_gcr_io') } } else {}),
                  }
              ) +
              {
                steps: std.flattenArrays(steps),
              } +
              (if ifClause != null then { 'if': ifClause } else {}) +
              (if needs != null then { needs: needs } else {}) +
              (if outputs != null then { outputs: outputs } else {}) +
              (if services != null then { services: services } else {}) +
              (if permissions == null then {} else { permissions: permissions }) +
              (if concurrency == null then {} else { concurrency: concurrency }) +
              (if continueOnError == null then {} else { 'continue-on-error': continueOnError }) +
              (if env == null then {} else { env: env }),
    },

  /**
   * Creates a GitHub Actions job that uses a reusable workflow from another repository.
   *
   * @param {string} name - The name of the job (used as the job key)
   * @param {string} uses - The reusable workflow reference (e.g., 'owner/repo/.github/workflows/workflow.yml@ref')
   * @param {object} [with=null] - Input parameters to pass to the reusable workflow
   * @returns {jobs} - GitHub Actions external job definition
   */
  ghExternalJob(
    name,
    uses,
    with=null,
  )::
    {
      [name]: {
        uses: uses,
      } + (if with != null then {
             with: with,
           } else {}),
    },

  /**
   * Creates a GitHub Actions step that runs shell commands.
   *
   * @docs https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idsteps
   *
   * @param {string} name - Display name for the step in the GitHub UI
   * @param {string} run - Shell command(s) to execute
   * @param {object} [env=null] - Environment variables for this step
   * @param {string} [workingDirectory=null] - Directory to run the command in
   * @param {string} [ifClause=null] - Conditional expression to determine if step should run
   * @param {string} [id=null] - Unique identifier for this step (used to reference outputs)
   * @param {boolean} [continueOnError=null] - Whether to continue job if this step fails, defaults to false
   * @param {string} [shell=null] - Shell to use for running commands (e.g., 'bash', 'python', 'powershell', defaults to 'bash')
   * @returns {steps} - Array containing a single step object

   * @example
    * base.step(
    *   name='Run tests',
    *   run='pytest tests/',
    *   env={ 'ENV_VAR': 'value' },
    *   workingDirectory='backend',
    * )
    *
    * base.step(
    *   name='Set up Python',
    *   run=|||
    *     python -m venv venv
    *     source venv/bin/activate
    *     pip install -r requirements.txt
    *   |||,
    * )
   */
  step(name, run, env=null, workingDirectory=null, ifClause=null, id=null, continueOnError=null, shell=null)::
    [
      {
        name: name,
        run: run,
      } + (if workingDirectory != null then { 'working-directory': workingDirectory } else {})
      + (if env != null then { env: env } else {})
      + (if ifClause != null then { 'if': ifClause } else {})
      + (if id != null then { id: id } else {})
      + (if continueOnError == null then {} else { 'continue-on-error': continueOnError })
      + (if shell == null then {} else { 'shell': shell }),
    ],

  /**
   * Creates a GitHub Actions step that uses a predefined action from the marketplace or repository.
   * Security: Prefer pinning action references to a full commit SHA (e.g., actions/checkout@<commit_sha>) instead of a mutable tag/version,
   * especially for lesser-known or smaller third-party actions to reduce supply chain attack risk.
   *
   * @docs https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idsteps
   *
   * @param {string} name - Display name for the step in the GitHub UI
   * @param {string} uses - The action to use (e.g., 'actions/checkout@v4', './path/to/action')
   * @param {object} [env=null] - Environment variables for this step
   * @param {object} [with=null] - Input parameters to pass to the action
   * @param {string} [id=null] - Unique identifier for this step (used to reference outputs)
   * @param {string} [ifClause=null] - Conditional expression to determine if step should run
   * @param {boolean} [continueOnError=null] - Whether to continue job if this step fails
   * @returns {steps} - Array containing a single step object
   */
  action(name, uses, env=null, with=null, id=null, ifClause=null, continueOnError=null)::
    [
      {
        name: name,
        uses: uses,
      } + (if env != null then { env: env } else {})
      + (if with != null && with != {} then { with: with } else {})
      + (if id != null then { id: id } else {})
      + (if ifClause != null then { 'if': ifClause } else {})
      + (if continueOnError == null then {} else { 'continue-on-error': continueOnError }),
    ],
}
