local base = import 'base.jsonnet';
local database = import 'databases.jsonnet';
local docker = import 'docker.jsonnet';
local helm = import 'helm.jsonnet';
local misc = import 'misc.jsonnet';
local notifications = import 'notifications.jsonnet';
local servicesImport = import 'services.jsonnet';

{
  /**
   * Creates a complete PR deployment pipeline for Ruby/Rails applications.
   *
   * Handles Docker image building, database cloning, migrations, and Helm deployment
   * for pull request environments with automatic cleanup.
   *
   * @param {string} serviceName - Name of the Ruby service
   * @param {string} [dockerImageName='backend-' + serviceName] - Docker image name to build
   * @param {object} [helmDeployOptions] - Helm deployment configuration
   * @param {object} helmDeployOptions.ingress - Ingress configuration
   * @param {object} helmDeployOptions.cronjob - Cronjob configuration
   * @param {object} [mysqlCloneOptions={}] - Database cloning options for PR isolation
   * @param {boolean} mysqlCloneOptions.enabled - Whether to clone database for PR
   * @param {string} mysqlCloneOptions.database_name_target - Target PR database name
   * @param {string} mysqlCloneOptions.database_name_source - Source database to clone
   * @param {object} [migrateOptions={}] - Rails migration options
   * @param {boolean} migrateOptions.enabled - Whether to run migrations
   * @param {string} migrateOptions.RAILS_ENV - Rails environment
   * @param {string} rubyImageName - Ruby base image for the job (required)
   * @returns {workflows} - Complete GitHub Actions pipeline for Ruby PR deployment
   */
  rubyDeployPRPipeline(
    serviceName,
    dockerImageName='backend-' + serviceName,
    helmDeployOptions={
      ingress: { enabled: true },
      cronjob: { enabled: true },
    },
    mysqlCloneOptions={},
    migrateOptions={},
    rubyImageName=null,
  )::
    assert rubyImageName != null;
    local mysqlCloneOptionsWithDefaults = {
      enabled: false,  // default for backwards compatibility. example params below
      database_name_target: serviceName + '_pr_${{ github.event.number }}',
      database_name_source: serviceName,
      database_host: 'cloudsql-proxy',
      database_username: serviceName,
      database_password: misc.secret('database_password_test'),
    } + mysqlCloneOptions;

    local migrateOptionsWithDefaults = {
      enabled: false,
      RAILS_ENV: 'production',
      RAILS_DB_HOST: 'cloudsql-proxy',
      RAILS_DB_NAME: serviceName + '_pr_${{ github.event.number }}',
      RAILS_DB_PASSWORD: misc.secret('database_password_test'),
      RAILS_DB_USER: serviceName,
      SECRET_KEY_BASE: misc.secret('rails_secret_test'),
    } + migrateOptions;

    base.pipeline(
      'deploy-pr',
      [
        base.ghJob(
          'deploy-pr',
          image=rubyImageName,
          steps=[
                  misc.checkout(ref='${{ github.event.pull_request.head.sha }}'),
                  self.setVerionFile(),
                ] +
                (if mysqlCloneOptionsWithDefaults.enabled then [database.copyDatabase(mysqlCloneOptionsWithDefaults)] else []) +
                (if migrateOptionsWithDefaults.enabled then self.rubyMigrate(migrateOptionsWithDefaults) else []) +
                [
                  docker.buildDocker(
                    dockerImageName,
                    env={
                      BUNDLE_GITHUB__COM: misc.secret('BUNDLE_GITHUB__COM'),
                    },
                    build_args='BUNDLE_GITHUB__COM=' + misc.secret('BUNDLE_GITHUB__COM'),
                  ),
                  helm.helmDeployPR(serviceName, helmDeployOptions, wait=true),
                ],
          services={} +
                   (if mysqlCloneOptionsWithDefaults.enabled then { 'cloudsql-proxy': servicesImport.cloudsql_proxy_service(mysqlCloneOptionsWithDefaults.database) } else {})
        ),
      ],
      event='pull_request',
    ),

  /**
   * Creates steps to run Rails database migrations and seeding.
   *
   * @param {object} migrateOptions - Rails migration configuration
   * @param {string} migrateOptions.RAILS_DB_HOST - Database host
   * @param {string} migrateOptions.RAILS_DB_NAME - Database name
   * @param {string} migrateOptions.RAILS_DB_PASSWORD - Database password
   * @param {string} migrateOptions.RAILS_DB_USER - Database user
   * @param {string} migrateOptions.SECRET_KEY_BASE - Rails secret key
   * @returns {steps} - GitHub Actions steps for bundle install, migrate, and seed
   */
  rubyMigrate(migrateOptions)::
    local env = {
      BUNDLE_GITHUB__COM: misc.secret('BUNDLE_GITHUB__COM'),
      SSO_PUBLIC_KEY: '',
      RAILS_ENV: 'production',
      RAILS_DB_HOST: migrateOptions.RAILS_DB_HOST,
      RAILS_DB_NAME: migrateOptions.RAILS_DB_NAME,
      RAILS_DB_PASSWORD: migrateOptions.RAILS_DB_PASSWORD,
      RAILS_DB_USER: migrateOptions.RAILS_DB_USER,
      SECRET_KEY_BASE: migrateOptions.SECRET_KEY_BASE,
    };

    [
      base.step('bundle install', 'bundle install', env={ BUNDLE_GITHUB__COM: misc.secret('BUNDLE_GITHUB__COM') }),
      base.step('migrate-db', 'rails db:migrate;', env=env),
      base.step('seed-db', 'rails db:seed;', env=env),
    ]
  ,

  /**
   * Creates a job to generate and deploy API documentation for Ruby applications.
   *
   * Generates Rails API docs and uploads them to Google Cloud Storage for hosting.
   *
   * @param {string} serviceName - Name of the service for documentation
   * @param {boolean} [enableDatabase=false] - Whether to enable database service
   * @param {string} [generateCommands=null] - Custom commands for doc generation
   * @param {object} [extra_env={}] - Additional environment variables
   * @param {object} [services] - Database services configuration
   * @param {string} rubyImageName - Ruby base image for the job (required)
   * @returns {jobs} - GitHub Actions job for API documentation deployment
   */
  deployApiDocs(
    serviceName,
    enableDatabase=false,
    generateCommands=null,
    extra_env={},
    services={ db: servicesImport.mysql8service(database='ci', password='ci', root_password='1234test', username='ci', version='8.4') },
    rubyImageName=null,
  )::
    assert rubyImageName != null;
    base.ghJob(
      'apidocs',
      image=rubyImageName,
      ifClause="${{ github.event.deployment.environment == 'production' }}",
      steps=[
        misc.checkout(),
        base.step(
          'generate',
          (if generateCommands != null then generateCommands else
             ' bundle config --delete without;\n            bundle install;\n            bundle exec rails db:test:prepare;\n            bundle exec rails docs:generate;\n          '),
          env={
                RAILS_ENV: 'test',
                GOOGLE_PRIVATE_KEY: misc.secret('GOOGLE_PRIVATE_KEY'),
                BUNDLE_GITHUB__COM: misc.secret('BUNDLE_GITHUB__COM'),
              } +
              (if enableDatabase then
                 {
                   RAILS_DB_HOST: 'db',
                   RAILS_DB_NAME: 'ci',
                   RAILS_DB_PASSWORD: 'ci',
                   RAILS_DB_USER: 'ci',
                 } else {}) + extra_env
        ),
        base.action(
          'setup auth',
          'google-github-actions/auth@v2',
          with={
            credentials_json: misc.secret('GCE_JSON'),
          },
          id='auth',
        ),
        base.action('setup-gcloud', 'google-github-actions/setup-gcloud@v2'),
        base.step('deploy-api-docs', 'gsutil -m cp -r doc/api/** gs://apidocs.gynzy.com/' + serviceName + '/'),
      ],
      services=(if enableDatabase then services else null),
    ),

  /**
   * Creates a step to set version information in a file.
   *
   * @param {string} [version='${{ github.event.pull_request.head.sha }}'] - Version string to write
   * @param {string} [file='VERSION'] - Target file for version information
   * @returns {steps} - GitHub Actions step that writes version to file
   */
  setVerionFile(version='${{ github.event.pull_request.head.sha }}', file='VERSION')::
    base.step(
      'set-version',
      'echo "' + version + '" > ' + file + ';\n        echo "Generated version number:";\n        cat ' + file + ';\n      '
    ),

  /**
   * Creates a pipeline to automatically clean up PR deployments when PRs are closed.
   *
   * @param {string} serviceName - Name of the Ruby service to clean up
   * @param {object} [options={}] - Helm cleanup options
   * @param {string} [helmPath='./helm/' + serviceName] - Path to Helm chart
   * @param {string} [deploymentName=serviceName + '-pr-${{ github.event.number }}'] - PR deployment name
   * @param {object} [mysqlDeleteOptions={}] - Database cleanup options
   * @param {boolean} mysqlDeleteOptions.enabled - Whether to delete PR database
   * @returns {workflows} - GitHub Actions pipeline for automatic PR cleanup
   */
  rubyDeletePRPipeline(
    serviceName,
    options={},
    helmPath='./helm/' + serviceName,
    deploymentName=serviceName + '-pr-${{ github.event.number }}',
    mysqlDeleteOptions={},
  )::
    local mysqlDeleteOptionsWithDefaults = {
      enabled: false,
      database_name_target: serviceName + '_pr_${{ github.event.number }}',
      database_host: 'cloudsql-proxy',
      database_username: serviceName,
      database_password: misc.secret('database_password_test'),
    } + mysqlDeleteOptions;

    base.pipeline(
      'close-pr',
      [
        helm.helmDeletePRJob(serviceName, options, helmPath, deploymentName, mysqlDeleteOptionsWithDefaults),
      ],
      event={
        pull_request: {
          types: ['closed'],
        },
      },
    ),

  /**
   * Creates a GitHub Actions job for Ruby application deployment to test environment.
   *
   * @param {string} serviceName - Name of the Ruby service
   * @param {object} [options={}] - Helm deployment options
   * @param {string} [helmPath='./helm/' + serviceName] - Path to Helm chart
   * @param {string} [deploymentName=serviceName + '-master'] - Test deployment name
   * @param {string} image - Container image for the job (required)
   * @param {boolean} [useCredentials=false] - Whether to use Docker registry credentials
   * @param {object} [migrateOptions={}] - Rails migration options
   * @param {bool} wait [true] - let helm wait for pods to come online otherwise fail the job
   * @param {timeout}  [10m] - how long to wait until the pods come online
   * @returns {jobs} - GitHub Actions job for test environment deployment
   */
  rubyDeployTestJob(
    serviceName,
    options={},
    helmPath='./helm/' + serviceName,
    deploymentName=serviceName + '-master',
    image=null,
    useCredentials=false,
    migrateOptions={},
    wait=true,
    timeout='10m',
  )::
    assert image != null;
    local migrateOptionsWithDefaults = {
      enabled: false,
      RAILS_ENV: 'production',
      RAILS_DB_HOST: 'cloudsql-proxy',
      RAILS_DB_NAME: serviceName,
      RAILS_DB_PASSWORD: misc.secret('database_password_test'),
      RAILS_DB_USER: serviceName,
      SECRET_KEY_BASE: misc.secret('rails_secret_test'),
    } + migrateOptions;

    base.ghJob(
      'deploy-test',
      ifClause="${{ github.event.deployment.environment == 'test' }}",
      image=image,
      useCredentials=useCredentials,
      steps=
      [misc.checkout()] +
      (if migrateOptionsWithDefaults.enabled then self.rubyMigrate(migrateOptionsWithDefaults) else []) +
      [helm.helmDeployTest(serviceName, options, helmPath, deploymentName, wait=wait, timeout=timeout)],
      services={} +
               (if migrateOptionsWithDefaults.enabled then { 'cloudsql-proxy': servicesImport.cloudsql_proxy_service(migrateOptionsWithDefaults.database) } else {})
    ),

  /**
   * Creates a GitHub Actions job for Ruby application deployment to production.
   *
   * Includes automatic failure notifications via Slack on deployment errors.
   *
   * @param {string} serviceName - Name of the Ruby service
   * @param {object} [options={}] - Helm deployment options
   * @param {string} [helmPath='./helm/' + serviceName] - Path to Helm chart
   * @param {string} [deploymentName=serviceName + '-prod'] - Production deployment name
   * @param {string} image - Container image for the job (required)
   * @param {boolean} [useCredentials=false] - Whether to use Docker registry credentials
   * @param {object} [migrateOptions={}] - Rails migration options
   * @param {bool} wait [true] - let helm wait for pods to come online otherwise fail the job
   * @param {timeout}  [10m] - how long to wait until the pods come online
   * @returns {jobs} - GitHub Actions job for production deployment with failure notifications
   */
  rubyDeployProdJob(
    serviceName,
    options={},
    helmPath='./helm/' + serviceName,
    deploymentName=serviceName + '-prod',
    image=null,
    useCredentials=false,
    migrateOptions={},
    wait=true,
    timeout='10m',
  )::
    assert image != null;
    local migrateOptionsWithDefaults = {
      enabled: false,
      RAILS_ENV: 'production',
      RAILS_DB_HOST: 'cloudsql-proxy',
      RAILS_DB_NAME: serviceName,
      RAILS_DB_PASSWORD: misc.secret('database_password_production'),
      RAILS_DB_USER: serviceName,
      SECRET_KEY_BASE: misc.secret('rails_secret_production'),
    } + migrateOptions;

    base.ghJob(
      'deploy-prod',
      ifClause="${{ github.event.deployment.environment == 'production' }}",
      image=image,
      useCredentials=useCredentials,
      steps=[misc.checkout()] +
            (if migrateOptionsWithDefaults.enabled then self.rubyMigrate(migrateOptionsWithDefaults) else []) +
            [helm.helmDeployProd(serviceName, options, helmPath, deploymentName, wait=wait, timeout=timeout)] + [notifications.notifiyDeployFailure()],
      services={} +
               (if migrateOptionsWithDefaults.enabled then { 'cloudsql-proxy': servicesImport.cloudsql_proxy_service(migrateOptionsWithDefaults.database) } else {})
    ),
}
