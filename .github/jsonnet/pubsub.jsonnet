local base = import 'base.jsonnet';
local misc = import 'misc.jsonnet';

{
  /**
   * Creates a GitHub Actions job to delete PR-specific Google Cloud Pub/Sub subscriptions.
   *
   * @param {array|string} [needs=null] - Job dependencies that must complete before this job runs
   * @returns {jobs} - GitHub Actions job definition for cleaning up PR-specific Pub/Sub subscriptions
   */
  deletePrPubsubSubscribersJob(needs=null)::
    base.ghJob(
      'delete-pubsub-pr-subscribers',
      useCredentials=false,
      image='google/cloud-sdk:alpine',
      steps=[
        misc.configureGoogleAuth(misc.secret('GCE_NEW_TEST_JSON')),
        base.step('install jq', 'apk add jq'),
        base.step('show auth', 'gcloud auth list'),
        base.step('wait for pod termination', 'sleep 60'),
        base.step(
          'delete subscriptions', "\n           gcloud --project gynzy-test-project pubsub subscriptions list --format json | jq -r '.[].name' | grep -- '-pr-${{ github.event.number }}' | xargs -r gcloud --project gynzy-test-project pubsub subscriptions delete"
        ),
      ],
      needs=needs,
    ),
}
