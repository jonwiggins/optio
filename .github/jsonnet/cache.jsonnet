local base = import 'base.jsonnet';

{
  /**
   * Fetch a cache from the cache server.
   * 
   * This is a generic function that can be used to fetch any cache. It is advised to wrap this function
   * in a more specific function that fetches a specific cache, setting the cacheName and folders parameters.
   * 
   * To be paired with the uploadCache function.
   *
   * @param {string} cacheName - The name of the cache to fetch. The name of the repository is usually a good option.
   * @param {string} [backupCacheName=null] - The name of a backup cache to fetch if the main cache fails.
   * @param {array} [folders=[]] - A list of folders that are in the cache. These will be deleted if the download fails. Can be an empty list if additionalCleanupCommands are used.
   * @param {string} [version='v1'] - The version of the cache to fetch.
   * @param {string} [backupCacheVersion=version] - The version of the backup cache to fetch.
   * @param {array} [additionalCleanupCommands=[]] - A list of additional commands to run if the download fails.
   * @param {string} [ifClause=null] - An optional if clause to conditionally run this step.
   * @param {string} [workingDirectory=null] - The working directory for this step.
   * @param {boolean} [retry=true] - Whether to retry the download if it fails.
   * @param {boolean} [continueWithoutCache=true] - Whether to continue if the cache is not found.
   * @returns {steps} - GitHub Actions step to download cache from Google Cloud Storage
   */
  fetchCache(
    cacheName,
    backupCacheName=null,
    folders=[],
    version='v1',
    backupCacheVersion=version,
    additionalCleanupCommands=[],
    ifClause=null,
    workingDirectory=null,
    retry=true,
    continueWithoutCache=true,
  )::
    assert std.length(folders) > 0 || std.length(additionalCleanupCommands) > 0;

    local downloadCommand(cacheName, version, nextSteps, indent = '') =
      indent + 'wget -q -O - "https://storage.googleapis.com/files-gynzy-com-test/ci-cache/' + cacheName + '-' + version + '.tar.zst" | tar --extract --zstd \n' +
      indent + 'if [ $? -ne 0 ]; then\n' +
      indent + '  echo "Cache download failed, cleanup up partial downloads"\n' +
      (if std.length(folders) > 0 then indent + '  rm -rf ' + std.join(' ', folders) + '\n' else '') +
      std.join(' ', std.map(function(cmd) indent + '  ' + cmd + '\n', additionalCleanupCommands)) +
      indent + '  echo "Cleanup complete"; echo\n\n' +
      nextSteps +
      indent + 'fi\n';

    local downloadCommandWithRetry(cacheName, version, nextSteps, indent = '') =
      downloadCommand(
        cacheName,
        version,
        if retry then
          indent + '  echo "Retrying download..."\n' +
          downloadCommand(cacheName, version, nextSteps, indent + '  ')
        else
          nextSteps,
        indent,
      );

    local backupIndent = (if retry then '    ' else '  ');

    local downloadFailedCommand = backupIndent + 'echo "Cache download failed :( ' + (if continueWithoutCache then 'Continuing without cache"' else 'Aborting"; exit 1') + '\n';

    base.step(
      'download ' + cacheName + ' cache',
      run=
      'set +e;\n' +
      'command -v zstd || { apt update && apt install -y zstd; }\n' +
      'echo "Downloading cache"\n' +
      downloadCommandWithRetry(
        cacheName,
        version,
        if backupCacheName != null then
          backupIndent + 'echo "Downloading backup cache"\n' +
          downloadCommandWithRetry(backupCacheName, backupCacheVersion, backupIndent + downloadFailedCommand, indent=backupIndent)
        else
          downloadFailedCommand,
      ),
      ifClause=ifClause,
      workingDirectory=workingDirectory,
    ),

  /**
   * Uploads a cache to the cache server.
   * 
   * This is a generic function that can be used to upload any cache. It is advised to wrap this function
   * in a more specific function that uploads a specific cache, setting the cacheName and folders parameters.
   * 
   * To be paired with the fetchCache function.
   *
   * @param {string} cacheName - The name of the cache to upload. The name of the repository is usually a good option.
   * @param {array} [folders=null] - A list of folders to include in the cache. Required unless tarCommand is given.
   * @param {string} [version='v1'] - The version of the cache to upload.
   * @param {number} [compressionLevel=10] - The compression level to use for zstd.
   * @param {string} [tarCommand='tar -c ' + std.join(' ', folders)] - The command to run to create the tar file.
   * @returns {steps} - GitHub Actions step to upload cache to Google Cloud Storage with zstd compression
   */
  uploadCache(
    cacheName,
    folders=null,
    version='v1',
    compressionLevel=10,
    tarCommand='tar -c ' + std.join(' ', folders),
  )::
    local cacheBucketPath = function(temp=false)
      'gs://files-gynzy-com-test/ci-cache/' + cacheName + '-' + version + '.tar.zst' + (if temp then '.tmp' else '');

    base.step(
      'upload-gatsby-cache',
      run=
      'set -e\n' +
      '\n' +
      'command -v zstd || { apt update && apt install -y zstd; }\n' +
      '\n' +
      'echo "Create and upload cache"\n' +
      tarCommand + ' | zstdmt -' + compressionLevel + ' | gsutil cp - "' + cacheBucketPath(temp=true) + '"\n' +
      'gsutil mv "' + cacheBucketPath(temp=true) + '" "' + cacheBucketPath(temp=false) + '"\n' +

      'echo "Upload finished"\n'
    ),

  /**
   * Removes a cache from the cache server and optionally removes local folders.
   *
   * This is a generic function that can be used to remove any cache. It is advised to wrap this function
   * in a more specific function that removes a specific cache, setting the cacheName parameter.
   *
   * @param {string} cacheName - The name of the cache to remove. The name of the repository is usually a good option.
   * @param {string} [version='v1'] - The version of the cache to remove.
   * @param {array} [folders=[]] - Local folders to delete alongside the remote cache.
   * @param {string} [ifClause=null] - An optional if clause to conditionally run this step.
   * @returns {steps} - GitHub Actions step to remove cache from Google Cloud Storage
   */
  removeCache(cacheName, version='v1', folders=[], ifClause=null)::
    base.step(
      'remove ' + cacheName + ' cache',
      run=
      'set +e;\n' +
      (if std.length(folders) > 0 then 'rm -rf ' + std.join(' ', folders) + '\n' else '') +
      'gsutil rm "gs://files-gynzy-com-test/ci-cache/' + cacheName + '-' + version + '.tar.zst"\n' +
      'echo "Cache removed"\n',
      ifClause=ifClause,
    ),
}
