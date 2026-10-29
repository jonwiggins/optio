import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({ api: {} }));

import { automationChoices, defaultEventSource } from "./automations-section";

describe("automationChoices (the deployment features)", () => {
  it("keeps every picker choice under the default deployment", () => {
    const c = automationChoices(featuresFromEnv({}));
    expect(c.agents).toEqual(["claude-code", "codex", "cursor", "gemini", "opencode"]);
    expect(c.ticketSources).toEqual(["github", "gitlab", "linear", "jira", "notion"]);
    expect(c.triggerTypes).toContain("github");
    expect(c.triggerTypes).toContain("slack");
    expect(c.presetIds).toEqual(["pr-review", "slack-channel", "linear-triage"]);
    expect(defaultEventSource(featuresFromEnv({}))).toBe("github");
  });

  it("offers the restricted deployment's runtimes, triggers and sources, GitLab by default", () => {
    const c = automationChoices(
      featuresFromEnv({
        OPTIO_RUNTIMES: "claude-code,opencode",
        OPTIO_GIT_PLATFORMS: "gitlab",
        OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
        OPTIO_TICKET_SOURCES: "gitlab,jira",
        OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
      }),
    );
    expect(c.agents).toEqual(["claude-code", "opencode"]);
    expect(c.ticketSources).toEqual(["gitlab", "jira"]);
    expect(c.triggerTypes).toEqual([
      "schedule",
      "webhook",
      "ticket",
      "gitlab",
      "jira",
      "sentry",
      "alertmanager",
    ]);
    expect(c.presetIds).toEqual([]);
    expect(
      defaultEventSource(
        featuresFromEnv({
          OPTIO_RUNTIMES: "claude-code,opencode",
          OPTIO_GIT_PLATFORMS: "gitlab",
          OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
          OPTIO_TICKET_SOURCES: "gitlab,jira",
          OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
        }),
      ),
    ).toBe("gitlab");
  });
});
