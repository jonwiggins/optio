/**
 * Docker Image Configuration
 *
 * This module defines standardized Docker images used across GitHub Actions workflows.
 * It centralizes image references to ensure consistency and simplify updates.
 * Images are primarily hosted on Google Cloud registries (GCR and Artifact Registry).
 */
{
  jsonnet_bin_image: 'europe-docker.pkg.dev/unicorn-985/private-images/docker-images_jsonnet:v1',
  helm_action_image: 'docker://europe-docker.pkg.dev/unicorn-985/public-images/helm-action:v4',
  mysql_action_image: 'docker://europe-docker.pkg.dev/unicorn-985/public-images/docker-images_mysql-cloner-action:v2',
  docker_action_image: 'docker://europe-docker.pkg.dev/unicorn-985/public-images/push-to-gcr-github-action:v1',
  default_job_image: 'mirror.gcr.io/alpine:3.20.0',
  default_mysql8_image: 'europe-docker.pkg.dev/unicorn-985/private-images/docker-images_mysql8_utf8mb4:v1',
  default_mysql84_image: 'europe-docker.pkg.dev/unicorn-985/private-images/docker-images_mysql84_utf8mb4:v1',
  default_cloudsql_image: 'europe-docker.pkg.dev/unicorn-985/private-images/docker-images_cloudsql-sidecar:v1',
  default_redis_image: 'mirror.gcr.io/redis:5.0.6',
  default_unicorns_image: 'mirror.gcr.io/node:22.16',
  default_pubsub_image: 'mirror.gcr.io/messagebird/gcloud-pubsub-emulator:latest',
  default_mongodb_image: 'europe-docker.pkg.dev/unicorn-985/private-images/docker-images_mongo8-replicated:v1',
  mongo_job_image: 'europe-docker.pkg.dev/unicorn-985/public-images/docker-images_mongo-cloner-job:v1',
  default_python_image: 'mirror.gcr.io/python:3.12.1',
  default_pulumi_node_image: 'mirror.gcr.io/node:22',
  job_poster_image: 'europe-docker.pkg.dev/unicorn-985/public-images/docker-images_job-poster:v2',
}
