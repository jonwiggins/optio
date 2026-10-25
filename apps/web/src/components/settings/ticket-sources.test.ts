import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect } from "vitest";
import { ticketSourceOptions } from "./ticket-sources";

// Settings → Tickets' built-in list (app/settings/page.tsx TICKET_SOURCES).
const BUILT_IN = [
  { value: "github", label: "GitHub Issues" },
  { value: "jira", label: "Jira" },
  { value: "linear", label: "Linear" },
  { value: "notion", label: "Notion" },
];

describe("ticketSourceOptions", () => {
  it("adds GitLab Issues to the built-in list under the default deployment", () => {
    expect(ticketSourceOptions(BUILT_IN, featuresFromEnv({}))).toEqual([
      ...BUILT_IN,
      { value: "gitlab", label: "GitLab Issues" },
    ]);
  });

  it("offers Jira and GitLab Issues under the restricted deployment", () => {
    expect(
      ticketSourceOptions(
        BUILT_IN,
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toEqual([
      { value: "jira", label: "Jira" },
      { value: "gitlab", label: "GitLab Issues" },
    ]);
  });
});
