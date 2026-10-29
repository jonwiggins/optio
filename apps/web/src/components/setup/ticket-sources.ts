import { featureFilter, type DeploymentFeatures } from "@optio/shared";

/** The third-party trackers the setup wizard's Tickets step can add, in its order. */
export const SETUP_TRACKER_SOURCES = ["linear", "notion", "jira"] as const;
export type SetupTrackerSource = (typeof SETUP_TRACKER_SOURCES)[number];

/** The trackers the deployment feature lists offer (OPTIO_TICKET_SOURCES). */
export function setupTrackerSources(features: DeploymentFeatures): SetupTrackerSource[] {
  return featureFilter("ticketSources", SETUP_TRACKER_SOURCES, features);
}
