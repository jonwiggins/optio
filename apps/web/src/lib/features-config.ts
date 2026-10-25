import {
  featureSettingsGiven,
  featuresFromEnv,
  type DeploymentFeatures,
} from "@optio/shared/features";

/**
 * What the root layout adds to `window.__OPTIO_CONFIG` for the feature lists
 * (docs/feature-lists.md): the features the web container's env describes,
 * so the first paint already hides what a list leaves out (`useFeatures`
 * confirms them from the API). Nothing when the env sets no feature setting:
 * the page then carries the existing config alone, and everything is offered.
 */
export function featuresConfig(env: Record<string, string | undefined> = process.env): {
  features?: DeploymentFeatures;
} {
  return featureSettingsGiven(env) ? { features: featuresFromEnv(env) } : {};
}
