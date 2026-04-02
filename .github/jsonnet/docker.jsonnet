local base = import 'base.jsonnet';
local images = import 'images.jsonnet';
local misc = import 'misc.jsonnet';

{
  /**
   * Builds a Docker image using the specified configuration.
   *
   * @param {string} imageName - The name of the Docker image to be built.
   * @param {string} [imageTag] - The tag to be used for the Docker image. Defaults to "deploy-<SHA>" of the current pull request.
   * @param {boolean|null} [isPublic] - whether the image should be public or private.
   *                                  If null the image name will need to be prefixed with artifact registry repository name
   * @param {string} [context] - The context path for the Docker build. defaults to: .
   * @param {string} [dockerfile] - The path to the Dockerfile to be used for the build.
   * @param {object} [env] - Environment variables to be passed to the Docker build.
   * @param {object} [build_args] - Build arguments to be passed to the Docker build.
   * @param {string} [project] - The GCP project where the image will be store/pushed to.
   * @returns {steps} - a github actions step to build the docker image
   */
  buildDocker(
    imageName,
    imageTag='deploy-${{ github.event.pull_request.head.sha }}',
    isPublic=false,
    context='.',
    dockerfile=null,
    env={},
    build_args=null,
    project='unicorn-985',
  )::
    base.action(
      'build-docker ' + imageName,
      images.docker_action_image,
      with={
             context: context,
             gcloud_service_key: misc.secret('docker_gcr_io_base64'),
             image_name: (if isPublic == null then '' else if isPublic == true then 'public-images/' else if isPublic == false then 'private-images/') + imageName,
             image_tag: imageTag,
             project_id: project,
             registry: 'europe-docker.pkg.dev',
           } +
           (if build_args != null then { build_args: build_args } else {}) +
           (if dockerfile != null then { dockerfile: dockerfile } else {}),
      env=env,
    ),
}
