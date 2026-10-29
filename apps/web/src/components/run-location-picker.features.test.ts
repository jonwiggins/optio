import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect } from "vitest";
import { localAgentChoices } from "./run-location-picker";

describe("localAgentChoices (the deployment features)", () => {
  it("names every local agent CLI under the default deployment", () => {
    expect(localAgentChoices(featuresFromEnv({}))).toBe(
      "Claude Code, Codex, Cursor, Gemini, or OpenCode",
    );
  });

  it("names the restricted deployment's two", () => {
    expect(
      localAgentChoices(
        featuresFromEnv({
          OPTIO_RUNTIMES: "claude-code,opencode",
          OPTIO_GIT_PLATFORMS: "gitlab",
          OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
          OPTIO_TICKET_SOURCES: "gitlab,jira",
          OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
        }),
      ),
    ).toBe("Claude Code or OpenCode");
  });
});
