local images = import 'images.jsonnet';
local misc = import 'misc.jsonnet';

{
  /**
   * Creates a MySQL 8.4 or 8.0 service container for GitHub Actions workflows.
   *
   * @param {string} [database=null] - Name of the database to create
   * @param {string} [password=null] - Password for the MySQL user
   * @param {string} [root_password=null] - Password for the MySQL root user
   * @param {string} [username=null] - MySQL username to create
   * @param {string} [port='3306'] - Port to expose the MySQL service on
   * @param {string} [version='8.4'] - MySQL version to use ('8.0' or '8.4')
   * @returns {object} - MySQL service configuration for GitHub Actions
   */
  mysql8service(database=null, password=null, root_password=null, username=null, port='3306', version="8.4")::
    {
      image: (if version == "8.0" then images.default_mysql8_image else images.default_mysql84_image),
      credentials: {
        username: '_json_key',
        password: misc.secret('docker_gcr_io'),
      },
      env: {
        MYSQL_DATABASE: database,
        MYSQL_PASSWORD: password,
        MYSQL_ROOT_PASSWORD: root_password,
        MYSQL_USER: username,
        MYSQL_TCP_PORT: port,
      },
      options: '--health-cmd="mysqladmin ping" --health-interval=1s --health-timeout=1s --health-retries=40',
      ports: [port + ':' + port],
    },

  /**
   * Creates a Cloud SQL Proxy service for connecting to Google Cloud SQL instances.
   *
   * @param {object} database - Database configuration object containing project, region, and server
   * @param {string} database.project - GCP project ID containing the Cloud SQL instance
   * @param {string} database.region - GCP region/zone where the Cloud SQL instance is located
   * @param {string} database.server - Cloud SQL instance name
   * @returns {object} - Cloud SQL Proxy service configuration for GitHub Actions
   */
  cloudsql_proxy_service(database)::
    {
      image: images.default_cloudsql_image,
      credentials: {
        username: '_json_key',
        password: misc.secret('docker_gcr_io'),
      },
      env: {
        GOOGLE_PROJECT: database.project,
        CLOUDSQL_ZONE: database.region,
        CLOUDSQL_INSTANCE: database.server,
        SERVICE_JSON: misc.secret('GCE_JSON'),
      },
      ports: ['3306:3306'],
    },

  /**
   * Creates a Redis service container for GitHub Actions workflows.
   *
   * @returns {object} - Redis service configuration for GitHub Actions (uses default Redis image)
   */
  redis_service():: {
    image: images.default_redis_image,
    ports: ['6379:6379'],
  },

  /**
   * Creates a Redis 7 service container for GitHub Actions workflows.
   *
   * @param {string} [port='6379'] - Port to expose the Redis service on
   * @returns {object} - Redis 7 service configuration for GitHub Actions
   */
  redis_service_v7(port='6379'):: {
    image: 'mirror.gcr.io/redis:7.0.15',
    ports: [port + ':' + port],
  },

  /**
   * Creates a Google Cloud Pub/Sub emulator service container for GitHub Actions workflows.
   *
   * @returns {object} - Pub/Sub emulator service configuration for GitHub Actions
   */
  pubsub_service():: {
    image: images.default_pubsub_image,
    ports: ['8681:8681'],
  },

  /**
   * Creates a MongoDB service container configured with replica set for GitHub Actions workflows.
   *
   * @param {string} service - Name of the service (used for naming the MongoDB service)
   * @param {string} [name='mongodb-' + service] - Custom name for the MongoDB service
   * @param {string} [username='root'] - MongoDB root username
   * @param {string} [password='therootpass'] - MongoDB root password
   * @returns {object} - MongoDB service configuration with replica set enabled and health checks
   */
  serviceMongodb(
    service,
    name='mongodb-' + service,
    username='root',
    password='therootpass',
  ):: {
    [name]: {
      image: images.default_mongodb_image,
      ports: ['27017:27017'],
      credentials: {
        username: '_json_key',
        password: misc.secret('docker_gcr_io'),
      },
      env: {
        MONGO_INITDB_ROOT_USERNAME: username,
        MONGO_INITDB_ROOT_PASSWORD: password,
        MONGO_REPLICA_SET_NAME: 'rs0',
      },
      options:
        '--health-cmd "bash -c \'echo \\\"rs.status().ok\\\" | /usr/bin/mongosh \\\"mongodb://' + username + ':' + password + '@localhost\\\" --quiet\'" --health-interval 1s --health-timeout 1s --health-retries 10',
    },
  },
}
