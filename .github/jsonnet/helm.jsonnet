local base = import 'base.jsonnet';
local clusters = import 'clusters.jsonnet';
local databases = import 'databases.jsonnet';
local images = import 'images.jsonnet';
local misc = import 'misc.jsonnet';
local services = import 'services.jsonnet';

{
  /**
   * Creates a GitHub Actions step to deploy or delete a Helm chart to a Kubernetes cluster.
   *
   * @param {object} cluster - Target Kubernetes cluster configuration
   * @param {string} cluster.project - GCP project containing the cluster
   * @param {string} cluster.zone - GCP zone where the cluster is located
   * @param {string} cluster.name - Name of the Kubernetes cluster
   * @param {string} cluster.secret - Secret containing cluster service account JSON
   * @param {string} release - Helm release name
   * @param {object|string} values - Helm values (object will be JSON-encoded)
   * @param {string} chartPath - Path to the Helm chart directory
   * @param {boolean} [delete=false] - Whether to delete the release instead of deploying
   * @param {boolean} [useHelm3=true] - Whether to use Helm 3 (recommended)
   * @param {string} [title=null] - Custom step name (defaults to 'deploy-helm' or 'delete-helm')
   * @param {string} [ifClause=null] - Conditional expression for step execution
   * @param {string} [ttl=null] - Time-to-live for the release (e.g., '7 days'), the release is deleted after this period
   * @param {string} [namespace='default'] - Kubernetes namespace for the release
   * @param {string} [version='${{ github.event.pull_request.head.sha }}'] - Version/tag for the deployment
   * @param {boolean} [fetchDependencies=false] - Whether to fetch Helm dependencies before deployment
   * @param {boolean} [wait=false] - Whether to wait for resources to be ready before marking the release as successful
   * @param {string} [timeout=null] - Time to wait for resources (pods) to become ready (e.g., '5m')
   * @returns {steps} - GitHub Actions step for Helm deployment
   */
  deployHelm(
    cluster,
    release,
    values,
    chartPath,
    delete=false,
    useHelm3=true,
    title=null,
    ifClause=null,
    ttl=null,
    namespace='default',
    version='${{ github.event.pull_request.head.sha }}',
    fetchDependencies=false,
    wait=false,
    timeout=null,
  )::
    base.action(
      (if title == null then if delete then 'delete-helm' else 'deploy-helm' else title),
      images.helm_action_image,
      with={
             clusterProject: cluster.project,
             clusterLocation: cluster.zone,
             clusterName: cluster.name,
             clusterSaJson: cluster.secret,
             release: release,
             namespace: namespace,
             chart: chartPath,
             atomic: 'false',
             token: '${{ github.token }}',
             version: version,
             'fetch-dependencies': (if fetchDependencies then 'true' else 'false'),
             wait: (if wait then 'true' else 'false'),
             values: if std.isString(values) then values else std.manifestJsonMinified(values),  // Accepts a string and an object due to legacy reasons.
           } + (if delete then { task: 'remove' } else {})
           + (if useHelm3 then { helm: 'helm3' } else { helm: 'helm' })
           + (if ttl != null then { ttl: ttl } else {})
           + (if timeout != null then { timeout: timeout } else {}),
      ifClause=ifClause,
    ),

  /**
   * Creates a Helm deployment step for production environment.
   *
   * @param {string} serviceName - Name of the service being deployed
   * @param {object} [options={}] - Additional Helm values to merge with defaults
   * @param {string} [helmPath='./helm/' + serviceName] - Path to the Helm chart
   * @param {string} [deploymentName=serviceName + '-prod'] - Helm release name
   * @param {string} [ifClause=null] - Conditional expression for step execution
   * @param {object} [cluster=clusters.prod] - Target cluster (defaults to production)
   * @param {string} [namespace='default'] - Kubernetes namespace
   * @param {string} [version='${{ github.event.pull_request.head.sha }}'] - Deployment version
   * @param {boolean} [fetchDependencies=false] - Whether to fetch Helm dependencies
   * @param {boolean} [wait=false] - Whether to wait for resources to be ready before marking the release as successful
   * @param {string} [timeout=null] - Time to wait for resources (pods) to become ready (e.g., '5m')
   * @returns {steps} - GitHub Actions step for production deployment
   */
  helmDeployProd(
    serviceName,
    options={},
    helmPath='./helm/' + serviceName,
    deploymentName=serviceName + '-prod',
    ifClause=null,
    cluster=clusters.prod,
    namespace='default',
    version='${{ github.event.pull_request.head.sha }}',
    fetchDependencies=false,
    wait=false,
    timeout=null,
  )::
    self.deployHelm(
      cluster,
      deploymentName,
      {
        environment: 'prod',
        identifier: 'prod',
        image: {
          tag: 'deploy-${{ github.sha }}',
        },
      } + options,
      helmPath,
      useHelm3=true,
      title='deploy-prod',
      ifClause=ifClause,
      namespace=namespace,
      version=version,
      fetchDependencies=fetchDependencies,
      wait=wait,
      timeout=timeout
    ),

  /**
   * Creates a complete GitHub Actions job for production deployment.
   *
   * @param {string} serviceName - Name of the service being deployed
   * @param {object} [options={}] - Additional Helm values to merge with defaults
   * @param {string} [helmPath='./helm/' + serviceName] - Path to the Helm chart
   * @param {string} [deploymentName=serviceName + '-prod'] - Helm release name
   * @param {string} [image=images.default_job_image] - Container image for the job
   * @param {boolean} [useCredentials=false] - Whether to use Docker registry credentials
   * @param {string} [environment='production'] - GitHub environment for deployment
   * @param {boolean} [fetchDependencies=false] - Whether to fetch Helm dependencies
   * @param {boolean} [wait=false] - Whether to wait for resources to be ready before marking the release as successful
   * @param {string} [timeout=null] - Time to wait for resources (pods) to become ready (e.g., '5m')
   * @returns {jobs} - Complete GitHub Actions job for production deployment
   */
  helmDeployProdJob(
    serviceName,
    options={},
    helmPath='./helm/' + serviceName,
    deploymentName=serviceName + '-prod',
    image=images.default_job_image,
    useCredentials=false,
    environment='production',
    fetchDependencies=false,
    wait=false,
    timeout=null,
  )::
    base.ghJob(
      'deploy-prod',
      ifClause="${{ github.event.deployment.environment == '" + environment + "' }}",
      image=image,
      useCredentials=useCredentials,
      steps=[
        misc.checkout(),
        self.helmDeployProd(serviceName, options, helmPath, deploymentName, fetchDependencies=fetchDependencies, wait=wait, timeout=timeout),
      ],
    ),

  /**
   * Creates a Helm deployment step for test/master environment.
   *
   * @param {string} serviceName - Name of the service being deployed
   * @param {object} [options={}] - Additional Helm values to merge with defaults
   * @param {string} [helmPath='./helm/' + serviceName] - Path to the Helm chart
   * @param {string} [deploymentName=serviceName + '-master'] - Helm release name
   * @param {object} [cluster=clusters.test] - Target cluster (defaults to test)
   * @param {string} [namespace='default'] - Kubernetes namespace
   * @param {boolean} [fetchDependencies=false] - Whether to fetch Helm dependencies
   * @param {boolean} [wait=false] - Whether to wait for resources to be ready before marking the release as successful
   * @param {string} [timeout=null] - Time to wait for resources (pods) to become ready (e.g., '5m')
   * @returns {steps} - GitHub Actions step for test environment deployment
   */
  helmDeployTest(
    serviceName,
    options={},
    helmPath='./helm/' + serviceName,
    deploymentName=serviceName + '-master',
    cluster=clusters.test,
    namespace='default',
    fetchDependencies=false,
    wait=false,
    timeout=null,
  )::
    self.deployHelm(
      cluster,
      deploymentName,
      {
        environment: 'test',
        identifier: 'master',
        image: {
          tag: 'deploy-${{ github.sha }}',
        },
      } + options,
      helmPath,
      useHelm3=true,
      title='deploy-test',
      namespace=namespace,
      fetchDependencies=fetchDependencies,
      wait=wait,
      timeout=timeout
    ),

  /**
   * Creates a complete GitHub Actions job for test environment deployment.
   *
   * @param {string} serviceName - Name of the service being deployed
   * @param {object} [options={}] - Additional Helm values to merge with defaults
   * @param {string} [helmPath='./helm/' + serviceName] - Path to the Helm chart
   * @param {string} [deploymentName=serviceName + '-master'] - Helm release name
   * @param {string} [image=images.default_job_image] - Container image for the job
   * @param {boolean} [useCredentials=false] - Whether to use Docker registry credentials
   * @param {boolean} [fetchDependencies=false] - Whether to fetch Helm dependencies
   * @param {boolean} [wait=false] - Whether to wait for resources to be ready before marking the release as successful
   * @param {string} [timeout=null] - Time to wait for resources (pods) to become ready (e.g., '5m')
   * @returns {jobs} - Complete GitHub Actions job for test deployment
   */
  helmDeployTestJob(
    serviceName,
    options={},
    helmPath='./helm/' + serviceName,
    deploymentName=serviceName + '-master',
    image=images.default_job_image,
    useCredentials=false,
    fetchDependencies=false,
    wait=false,
    timeout=null,
  )::
    base.ghJob(
      'deploy-test',
      ifClause="${{ github.event.deployment.environment == 'test' }}",
      image=image,
      useCredentials=useCredentials,
      steps=[
        misc.checkout(),
        self.helmDeployTest(serviceName, options, helmPath, deploymentName, fetchDependencies=fetchDependencies, wait=wait, timeout=timeout),
      ],
    ),

  /**
   * Creates a Helm deployment step for Pull Request environment.
   *
   * Deploys a PR-specific instance with a 7-day TTL for testing purposes.
   *
   * @param {string} serviceName - Name of the service being deployed
   * @param {object} [options={}] - Additional Helm values to merge with defaults
   * @param {string} [helmPath='./helm/' + serviceName] - Path to the Helm chart
   * @param {string} [deploymentName=serviceName + '-pr-${{ github.event.number }}'] - PR-specific release name
   * @param {object} [cluster=clusters.test] - Target cluster (defaults to test)
   * @param {string} [namespace='default'] - Kubernetes namespace
   * @param {boolean} [fetchDependencies=false] - Whether to fetch Helm dependencies
   * @param {boolean} [wait=false] - Whether to wait for resources to be ready before marking the release as successful
   * @param {string} [timeout=null] - Time to wait for resources (pods) to become ready (e.g., '5m')
   * @returns {steps} - GitHub Actions step for PR deployment with TTL
   */
  helmDeployPR(
    serviceName,
    options={},
    helmPath='./helm/' + serviceName,
    deploymentName=serviceName + '-pr-${{ github.event.number }}',
    cluster=clusters.test,
    namespace='default',
    fetchDependencies=false,
    wait=false,
    timeout=null,
  )::
    self.deployHelm(
      cluster,
      deploymentName,
      {
        environment: 'pr',
        identifier: 'pr-${{ github.event.number }}',
        image: {
          tag: 'deploy-${{ github.event.pull_request.head.sha }}',
        },
      } + options,
      helmPath,
      useHelm3=true,
      title='deploy-pr',
      ttl='7 days',
      namespace=namespace,
      fetchDependencies=fetchDependencies,
      wait=wait,
      timeout=timeout
    ),

  /**
   * Creates a complete GitHub Actions job for PR deployment.
   *
   * @param {string} serviceName - Name of the service being deployed
   * @param {object} [options={}] - Additional Helm values to merge with defaults
   * @param {string} [helmPath='./helm/' + serviceName] - Path to the Helm chart
   * @param {string} [deploymentName=serviceName + '-pr-${{ github.event.number }}'] - PR-specific release name
   * @param {string} [image=images.default_job_image] - Container image for the job
   * @param {boolean} [useCredentials=false] - Whether to use Docker registry credentials
   * @param {boolean} [fetchDependencies=false] - Whether to fetch Helm dependencies
   * @param {boolean} [wait=false] - Whether to wait for resources to be ready before marking the release as successful
   * @param {string} [timeout=null] - Time to wait for resources (pods) to become ready (e.g., '5m')
   * @returns {jobs} - Complete GitHub Actions job for PR deployment
   */
  helmDeployPRJob(
    serviceName,
    options={},
    helmPath='./helm/' + serviceName,
    deploymentName=serviceName + '-pr-${{ github.event.number }}',
    image=images.default_job_image,
    useCredentials=false,
    fetchDependencies=false,
    wait=false,
    timeout=null,
  )::
    base.ghJob(
      'deploy-pr',
      image=image,
      useCredentials=useCredentials,
      steps=[
        misc.checkout(),
        self.helmDeployPR(serviceName, options, helmPath, deploymentName, fetchDependencies=fetchDependencies, wait=wait, timeout=timeout),
      ],
    ),

  /**
   * Creates a Helm step to delete a PR deployment.
   *
   * @param {string} serviceName - Name of the service being deleted
   * @param {object} [options={}] - Helm values (usually not needed for deletion)
   * @param {string} [helmPath='./helm/' + serviceName] - Path to the Helm chart
   * @param {string} [deploymentName=serviceName + '-pr-${{ github.event.number }}'] - PR-specific release name to delete
   * @param {object} [cluster=clusters.test] - Target cluster (defaults to test)
   * @param {string} [namespace='default'] - Kubernetes namespace
   * @param {boolean} [fetchDependencies=false] - Whether to fetch Helm dependencies
   * @param {boolean} [wait=false] - Whether to wait for resources to be ready before marking the release as successful
   * @param {string} [timeout=null] - Time to wait for resources (pods) to become ready (e.g., '5m')
   * @returns {steps} - GitHub Actions step for PR deletion
   */
  helmDeletePr(
    serviceName,
    options={},
    helmPath='./helm/' + serviceName,
    deploymentName=serviceName + '-pr-${{ github.event.number }}',
    cluster=clusters.test,
    namespace='default',
    fetchDependencies=false,
    wait=false,
    timeout=null,
  )::
    self.deployHelm(
      cluster,
      deploymentName,
      options,
      helmPath,
      useHelm3=true,
      delete=true,
      title='delete-pr',
      namespace=namespace,
      wait=wait,
      timeout=timeout
    ),

  /**
   * Creates a complete GitHub Actions job for PR cleanup, including database deletion.
   *
   * @param {string} serviceName - Name of the service being cleaned up
   * @param {object} [options={}] - Helm values (usually not needed for deletion)
   * @param {string} [helmPath='./helm/' + serviceName] - Path to the Helm chart
   * @param {string} [deploymentName=serviceName + '-pr-${{ github.event.number }}'] - PR-specific release name to delete
   * @param {object} [mysqlDeleteOptions={ enabled: false }] - MySQL database cleanup options
   * @param {boolean} mysqlDeleteOptions.enabled - Whether to delete associated PR database
   * @param {boolean} [fetchDependencies=fetchDependencies] - Whether to fetch Helm dependencies
   * @param {boolean} [wait=false] - Whether to wait for resources to be ready before marking the release as successful
   * @param {string} [timeout=null] - Time to wait for resources (pods) to become ready (e.g., '5m')
   * @returns {jobs} - Complete GitHub Actions job for PR cleanup
   */
  helmDeletePRJob(
    serviceName,
    options={},
    helmPath='./helm/' + serviceName,
    deploymentName=serviceName + '-pr-${{ github.event.number }}',
    mysqlDeleteOptions={ enabled: false },
    fetchDependencies=fetchDependencies,
    wait=false,
    timeout=null,
  )::
    base.ghJob(
      'helm-delete-pr',
      image=images.default_job_image,
      useCredentials=false,
      steps=[
              misc.checkout(),
              self.helmDeletePr(serviceName, options, helmPath, deploymentName, fetchDependencies=fetchDependencies, wait=wait, timeout=timeout),
            ] +
            (if mysqlDeleteOptions.enabled then [databases.deleteDatabase(mysqlDeleteOptions)] else []),
      services=(if mysqlDeleteOptions.enabled then { 'cloudsql-proxy': services.cloudsql_proxy_service(mysqlDeleteOptions.database) } else null),
    ),

  /**
   * Creates a complete pipeline that automatically cleans up PR deployments when PRs are closed.
   *
   * @param {string} serviceName - Name of the service being cleaned up
   * @param {object} [options={}] - Helm values (usually not needed for deletion)
   * @param {string} [helmPath='./helm/' + serviceName] - Path to the Helm chart
   * @param {string} [deploymentName=serviceName + '-pr-${{ github.event.number }}'] - PR-specific release name to delete
   * @param {boolean} [fetchDependencies=false] - Whether to fetch Helm dependencies
   * @param {boolean} [wait=false] - Whether to wait for resources to be ready before marking the release as successful
   * @param {string} [timeout=null] - Time to wait for resources (pods) to become ready (e.g., '5m')
   * @returns {workflows} - Complete GitHub Actions pipeline for automatic PR cleanup
   */
  helmDeletePRPipeline(
    serviceName,
    options={},
    helmPath='./helm/' + serviceName,
    deploymentName=serviceName + '-pr-${{ github.event.number }}',
    fetchDependencies=false,
    wait=false,
    timeout=null,
  )::
    base.pipeline(
      'close-pr',
      [
        self.helmDeletePRJob(serviceName, options, helmPath, deploymentName, fetchDependencies=fetchDependencies, wait=wait, timeout=timeout),
      ],
      event={
        pull_request: {
          types: ['closed'],
        },
      }
    ),

  /**
   * Creates a Helm deployment step for canary releases in production.
   *
   * Deploys a single replica canary instance for gradual rollout testing.
   *
   * @param {string} serviceName - Name of the service being deployed
   * @param {object} [options={}] - Additional Helm values to merge with defaults
   * @param {string} [helmPath='./helm/' + serviceName + '-canary'] - Path to the canary Helm chart
   * @param {string} [deploymentName=serviceName + '-canary'] - Canary release name
   * @param {string} [ifClause=null] - Conditional expression for step execution
   * @param {boolean} [fetchDependencies=false] - Whether to fetch Helm dependencies
   * @param {boolean} [wait=false] - Whether to wait for resources to be ready before marking the release as successful
   * @param {string} [timeout=null] - Time to wait for resources (pods) to become ready (e.g., '5m')
   * @returns {steps} - GitHub Actions step for canary deployment
   */
  helmDeployCanary(
    serviceName,
    options={},
    helmPath='./helm/' + serviceName + '-canary',
    deploymentName=serviceName + '-canary',
    ifClause=null,
    fetchDependencies=false,
    wait=false,
    timeout=null,
  )::
    self.deployHelm(
      clusters.prod,
      deploymentName,
      {
        identifier: 'prod',
        environment: 'prod',
        image: {
          tag: 'deploy-${{ github.sha }}',
        },
        replicaCount: 1,
      } + options,
      helmPath,
      useHelm3=true,
      title='deploy-canary',
      ifClause=ifClause,
      fetchDependencies=fetchDependencies,
      wait=wait,
      timeout=timeout
    ),

  /**
   * Creates a complete GitHub Actions job for canary deployment.
   *
   * @param {string} serviceName - Name of the service being deployed
   * @param {object} [options={}] - Additional Helm values to merge with defaults
   * @param {string} [helmPath='./helm/' + serviceName + '-canary'] - Path to the canary Helm chart
   * @param {string} [deploymentName=serviceName + '-canary'] - Canary release name
   * @param {string} [image=images.default_job_image] - Container image for the job
   * @param {boolean} [useCredentials=false] - Whether to use Docker registry credentials
   * @param {boolean} [fetchDependencies=false] - Whether to fetch Helm dependencies
   * @param {boolean} [wait=false] - Whether to wait for resources to be ready before marking the release as successful
   * @param {string} [timeout=null] - Time to wait for resources (pods) to become ready (e.g., '5m')
   * @returns {jobs} - Complete GitHub Actions job for canary deployment
   */
  helmDeployCanaryJob(
    serviceName,
    options={},
    helmPath='./helm/' + serviceName + '-canary',
    deploymentName=serviceName + '-canary',
    image=images.default_job_image,
    useCredentials=false,
    fetchDependencies=false,
    wait=false,
    timeout=null,
  )::
    base.ghJob(
      'deploy-canary',
      image=image,
      useCredentials=useCredentials,
      ifClause="${{ github.event.deployment.environment == 'canary' }}",
      steps=[
        misc.checkout(),
        self.helmDeployCanary(
          serviceName, options, helmPath, deploymentName, fetchDependencies=fetchDependencies, wait=wait, timeout=timeout,
        ),
      ],
    ),

  /**
   * Creates a Helm step to scale down (kill) a canary deployment.
   *
   * Sets replica count to 0 to stop the canary without removing the release.
   *
   * @param {string} serviceName - Name of the service canary to scale down
   * @param {object} [options={}] - Additional Helm values to merge with defaults
   * @param {string} [helmPath='./helm/' + serviceName + '-canary'] - Path to the canary Helm chart
   * @param {string} [deploymentName=serviceName + '-canary'] - Canary release name
   * @param {string} [ifClause=null] - Conditional expression for step execution
   * @param {boolean} [fetchDependencies=false] - Whether to fetch Helm dependencies
   * @param {boolean} [wait=false] - Whether to wait for resources to be ready before marking the release as successful
   * @param {string} [timeout=null] - Time to wait for resources (pods) to become ready (e.g., '5m')
   * @returns {steps} - GitHub Actions step to scale down canary deployment
   */
  helmKillCanary(
    serviceName,
    options={},
    helmPath='./helm/' + serviceName + '-canary',
    deploymentName=serviceName + '-canary',
    ifClause=null,
    fetchDependencies=false,
    wait=false,
    timeout=null,
  )::
    self.deployHelm(
      clusters.prod,
      deploymentName,
      {
        identifier: 'prod',
        environment: 'prod',
        image: {
          tag: 'deploy-${{ github.sha }}',
        },
        replicaCount: 0,
      } + options,
      helmPath,
      useHelm3=true,
      title='kill-canary',
      ifClause=ifClause,
      fetchDependencies=fetchDependencies,
      wait=wait,
      timeout=timeout
    ),

  /**
   * Creates a complete GitHub Actions job to scale down canary deployments.
   *
   * Triggers when 'kill-canary' or 'production' deployment environments are used.
   *
   * @param {string} serviceName - Name of the service canary to scale down
   * @param {object} [options={}] - Additional Helm values to merge with defaults
   * @param {string} [helmPath='./helm/' + serviceName + '-canary'] - Path to the canary Helm chart
   * @param {string} [deploymentName=serviceName + '-canary'] - Canary release name
   * @param {boolean} [fetchDependencies=false] - Whether to fetch Helm dependencies
   * @param {boolean} [wait=false] - Whether to wait for resources to be ready before marking the release as successful
   * @param {string} [timeout=null] - Time to wait for resources (pods) to become ready (e.g., '5m')
   * @returns {jobs} - Complete GitHub Actions job to kill canary deployment
   */
  helmKillCanaryJob(
    serviceName,
    options={},
    helmPath='./helm/' + serviceName + '-canary',
    deploymentName=serviceName + '-canary',
    fetchDependencies=false,
    wait=false,
    timeout=null,
  )::
    base.ghJob(
      'kill-canary',
      ifClause="${{ github.event.deployment.environment == 'kill-canary' || github.event.deployment.environment == 'production' }}",
      image=images.default_job_image,
      useCredentials=false,
      steps=[
        misc.checkout(),
        self.helmKillCanary(serviceName, options, helmPath, deploymentName, fetchDependencies=fetchDependencies, wait=wait, timeout=timeout),
      ],
    ),
}
