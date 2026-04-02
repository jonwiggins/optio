local base = import 'base.jsonnet';
local misc = import 'misc.jsonnet';

{
  /**
   * Load secrets from 1Password PRODUCTION vault into the GitHub workflow.
   *
   * Requirements:
   * - Cannot be run on Alpine image
   * - Must have the following CLI tools available: curl, bash, unzip
   *
   * WARNING: The integration is flaky, there are no retries for transient failures on the 1Password side.
   * See: https://github.com/1Password/load-secrets-action/issues/102
   *
   * The exported secrets can then be referenced in subsequent steps:
   * ${{ steps.load-1password-secrets.outputs.SECRET_NAME }}
   * Or as environment variables:
   * env: onepassword.env('load-1password-secrets', ['SECRET_NAME'])
   *
   * @param {string} [stepName='load-1password-secrets'] - The name of the step
   * @param {object} [secrets={}] - Dictionary of secrets to load, e.g.:
   *   - {SECRET_NAME: 'vaultItem/keyName'}
   *   - {SECRET_NAME: 'OAuth client id/notesPlain'} // for a secure note
   *   - {SECRET_NAME: 'somePassword/password'} // for a username/password combination
   *   The function will automatically prefix with the vault: 'op://Pulumi Prod/'
   * @returns {steps} - GitHub Actions step that loads secrets from 1Password Production vault
   */
  loadSecretsProd(
    stepName='load-1password-secrets',
    secrets={},
  )::
    local prefixedSecrets = std.mapWithKey(function(key, value) 'op://Pulumi Prod/' + value, secrets);
    base.action(
      stepName,
      '1password/load-secrets-action@v2.0.0',
      id=stepName,
      with={
        'export-env': false,
      },
      env=
      prefixedSecrets
      { OP_SERVICE_ACCOUNT_TOKEN: misc.secret('PULUMI_1PASSWORD_PROD') },
    ),

  /**
   * Load secrets from 1Password TEST vault into the GitHub workflow.
   *
   * Requirements:
   * - Cannot be run on Alpine image
   * - Must have the following CLI tools available: curl, bash, unzip
   *
   * WARNING: The integration is flaky, there are no retries for transient failures on the 1Password side.
   * See: https://github.com/1Password/load-secrets-action/issues/102
   *
   * The exported secrets can then be referenced in subsequent steps:
   * ${{ steps.load-1password-secrets.outputs.SECRET_NAME }}
   * Or as environment variables:
   * env: onepassword.env('load-1password-secrets', ['SECRET_NAME'])
   *
   * @param {string} [stepName='load-1password-secrets'] - The name of the step
   * @param {object} [secrets={}] - Dictionary of secrets to load, e.g.:
   *   - {SECRET_NAME: 'vaultItem/keyName'}
   *   - {SECRET_NAME: 'OAuth client id/notesPlain'} // for a secure note
   *   - {SECRET_NAME: 'somePassword/password'} // for a username/password combination
   *   The function will automatically prefix with the vault: 'op://Pulumi Test/'
   * @returns {steps} - GitHub Actions step that loads secrets from 1Password Test vault
   */
  loadSecretsTest(
    stepName='load-1password-secrets',
    secrets={},
  )::
    local prefixedSecrets = std.mapWithKey(function(key, value) 'op://Pulumi Test/' + value, secrets);
    base.action(
      stepName,
      '1password/load-secrets-action@v2.0.0',
      id=stepName,
      with={
        'export-env': false,
      },
      env=
      prefixedSecrets
      { OP_SERVICE_ACCOUNT_TOKEN: misc.secret('PULUMI_1PASSWORD_TEST') },
    ),

  /**
   * Pass earlier loaded secrets as environment variables to the next step.
   *
   * Helper function to generate environment variable mappings for secrets loaded by 1Password steps.
   *
   * @param {string} stepName - The name of the step that loaded the secrets (e.g., 'load-1password-secrets')
   * @param {array} [secrets=[]] - Array of secret names to map (e.g., ['SECRET_A', 'SECRET_B'])
   * @returns {object} - Object mapping secret names to their GitHub Actions output references: { SECRET_A: '${{ steps.load-1password-secrets.outputs.SECRET_A }}' }
   *
   * @example
   * onepassword.env('load-1password-secrets', ['SECRET_A', 'SECRET_B'])
   */
  env(stepName, secrets=[])::
    std.foldl(
      function(acc, secretName) acc + { [secretName]: '${{ steps.' + stepName + '.outputs.' + secretName + ' }}' },
      secrets,
      {}
    ),
}
