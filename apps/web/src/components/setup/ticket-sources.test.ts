import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect } from "vitest";
import { setupTrackerSources } from "./ticket-sources";

describe("setupTrackerSources", () => {
  it("offers Linear, Notion and Jira under the default deployment", () => {
    expect(setupTrackerSources(featuresFromEnv({}))).toEqual(["linear", "notion", "jira"]);
  });

  it("offers Jira alone under the restricted deployment", () => {
    expect(
      setupTrackerSources(
        featuresFromEnv({
          OPTIO_RUNTIMES: "claude-code,opencode",
          OPTIO_GIT_PLATFORMS: "gitlab",
          OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
          OPTIO_TICKET_SOURCES: "gitlab,jira",
          OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
        }),
      ),
    ).toEqual(["jira"]);
  });
});
