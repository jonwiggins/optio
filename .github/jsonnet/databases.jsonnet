local base = import 'base.jsonnet';
local images = import 'images.jsonnet';

{
  /**
   * Configuration for available database servers across different environments and services.
   *
   * Each database server entry contains:
   * - type: Database type (currently 'mysql')
   * - server: Cloud SQL instance name
   * - region: GCP region where the instance is located
   * - project: GCP project ID containing the instance
   * - lifecycle: Environment tier (test/production)
   */
  database_servers: {
    'test-ams-8': {
      type: 'mysql',
      server: 'test-ams-8',
      region: 'europe-west4',
      project: 'unicorn-985',
      lifecycle: 'test',
    },
    'eu-w4-test': {
      type: 'mysql',
      server: 'eu-w4-test',
      region: 'europe-west4',
      project: 'unicorn-985',
      lifecycle: 'test',
    },
    'eu-w4-unicorn-production': {
      type: 'mysql',
      server: 'eu-w4-unicorn-production',
      region: 'europe-west4',
      project: 'unicorn-985',
    },
    'eu-w4-licenses-v8': {
      type: 'mysql',
      server: 'eu-w4-licenses-v8',
      region: 'europe-west4',
      project: 'unicorn-985',
    },
    'eu-w4-curriculum-v8': {
      type: 'mysql',
      server: 'eu-w4-curriculum-v8',
      region: 'europe-west4',
      project: 'unicorn-985',
    },
    'eu-w4-enrollments-v8': {
      type: 'mysql',
      server: 'eu-w4-enrollments-v8',
      region: 'europe-west4',
      project: 'unicorn-985',
    },
    'eu-w4-board-v8': {
      type: 'mysql',
      server: 'eu-w4-board-v8',
      region: 'europe-west4',
      project: 'unicorn-985',
    },
    'eu-w4-accounts-v8': {
      type: 'mysql',
      server: 'eu-w4-accounts-v8',
      region: 'europe-west4',
      project: 'unicorn-985',
    },
    'eu-w4-metrics-v8': {
      type: 'mysql',
      server: 'eu-w4-metrics-v8',
      region: 'europe-west4',
      project: 'unicorn-985',
    },
    'eu-w4-groups-v8': {
      type: 'mysql',
      server: 'eu-w4-groups-v8',
      region: 'europe-west4',
      project: 'unicorn-985',
    },
    'eu-w4-edu-v': {
      type: 'mysql',
      server: 'eu-w4-edu-v',
      region: 'europe-west4',
      project: 'unicorn-985',
    },
  },

  /**
   * Creates a GitHub Actions step to copy a MySQL database for PR testing.
   *
   * This function creates a step that clones a source database to a PR-specific database
   * for isolated testing. The target database name must contain '_pr_' for safety.
   *
   * @param {object} mysqlActionOptions - MySQL action configuration object
   * @param {string} mysqlActionOptions.database_name_target - Target database name (must contain '_pr_')
   * @param {string} mysqlActionOptions.database_name_source - Source database to copy from
   * @param {object} mysqlActionOptions.database_server - Database server configuration
   * @returns {steps} - GitHub Actions step that copies the database
   */
  copyDatabase(mysqlActionOptions)::
    assert std.length(std.findSubstr('_pr_', mysqlActionOptions.database_name_target)) > 0;  // target db gets deleted. must contain _pr_

    // overwrite and set task to clone
    // delete database by setting it to null and calling prune afterwards
    local pluginOptions = std.prune(mysqlActionOptions { task: 'clone', database: null });

    base.action(
      'copy-database',
      images.mysql_action_image,
      with=pluginOptions
    ),

  /**
   * Creates a GitHub Actions step to delete a MySQL PR database.
   *
   * This function creates a step that removes a PR-specific database after testing is complete.
   * The target database name must contain '_pr_' for safety to prevent accidental deletion
   * of production databases.
   *
   * @param {object} mysqlActionOptions - MySQL action configuration object
   * @param {string} mysqlActionOptions.database_name_target - Target database name to delete (must contain '_pr_')
   * @param {object} mysqlActionOptions.database_server - Database server configuration
   * @returns {steps} - GitHub Actions step that deletes the database
   */
  deleteDatabase(mysqlActionOptions)::
    assert std.length(std.findSubstr('_pr_', mysqlActionOptions.database_name_target)) > 0;  // this fn deletes the database. destination db must contain _pr_

    // overwrite and set task to clone
    // delete database by setting it to null and calling prune afterwards
    local pluginOptions = std.prune(mysqlActionOptions { task: 'remove', database: null });

    base.action(
      'delete-database',
      images.mysql_action_image,
      with=pluginOptions
    ),
}
