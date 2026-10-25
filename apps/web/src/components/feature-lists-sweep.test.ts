import { featuresFromEnv } from "@optio/shared/features";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({ api: {} }));

import {
  AGENT_TYPES,
  LOCAL_AGENT_KINDS,
  MODEL_PROVIDER_AGENTS,
  ALL_CONNECTION_PROVIDERS,
  featureFilter,
  type ConnectionProvider,
} from "@optio/shared";
import { defaultTicketSource, ticketSourcesFor } from "./trigger-selector";
import { localAgentChoices } from "./run-location-picker";
import { automationChoices, defaultEventSource } from "./local/automations-section";
import { ticketSourceOptions } from "./settings/ticket-sources";
import { setupTrackerSources } from "./setup/ticket-sources";
import { galleryOffers, serviceProviders } from "./connections/connect-gallery";
import { draftForFeatures, EMPTY_DRAFT, PRESETS, whenTypesFor } from "./work-form/model";
import { agentWritesChat } from "./local/session-view";

/**
 * A sweep of every pick list the web builds from the deployment features:
 * under the restricted deployment each offers only what it keeps (runtimes
 * claude-code + opencode, GitLab, the eight triggers (Sentry and Alertmanager
 * among them: self-hostable, receive-only), Jira + GitLab tickets,
 * the four connection providers), and under the default deployment each is
 * the built-in list as it was.
 */

const STANDARD_RUNTIMES = ["claude-code", "opencode"];
const STANDARD_TRIGGERS = [
  "manual",
  "schedule",
  "webhook",
  "ticket",
  "gitlab",
  "jira",
  "sentry",
  "alertmanager",
];
const CLOUD_TRIGGERS = ["github", "slack", "linear", "pylon", "pagerduty", "datadog"];

/** The built-in Settings → Tickets list (app/settings/page.tsx). */
const BUILT_IN_TICKET_OPTIONS = [
  { value: "github", label: "GitHub Issues" },
  { value: "linear", label: "Linear" },
  { value: "jira", label: "Jira" },
  { value: "notion", label: "Notion" },
];

const provider = (slug: string) =>
  ({ slug, name: slug, builtIn: true }) as unknown as ConnectionProvider;
const CATALOG = ["github-enhanced", ...ALL_CONNECTION_PROVIDERS.filter((s) => s !== "github")].map(
  provider,
);

describe("restricted deployment sweep — web pick lists", () => {
  it("offers only the restricted deployment's runtimes in every agent list", () => {
    expect(
      featureFilter(
        "runtimes",
        AGENT_TYPES,
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toEqual(STANDARD_RUNTIMES);
    expect(
      featureFilter(
        "runtimes",
        MODEL_PROVIDER_AGENTS,
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toEqual(STANDARD_RUNTIMES);
    expect(
      featureFilter(
        "runtimes",
        LOCAL_AGENT_KINDS,
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toEqual(STANDARD_RUNTIMES);
    expect(
      localAgentChoices(
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toBe("Claude Code or OpenCode");
    expect(
      automationChoices(
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ).agents,
    ).toEqual(STANDARD_RUNTIMES);
    expect(
      agentWritesChat(
        "codex",
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toBe(false);
    expect(
      agentWritesChat(
        "claude-code",
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toBe(true);
  });

  it("offers only the restricted deployment's triggers", () => {
    expect(
      whenTypesFor(
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toEqual(STANDARD_TRIGGERS);
    const { triggerTypes, presetIds } = automationChoices(
      featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
    );
    expect(triggerTypes.every((t) => STANDARD_TRIGGERS.includes(t))).toBe(true);
    for (const t of CLOUD_TRIGGERS) expect(triggerTypes).not.toContain(t);
    // The GitHub / Slack / Linear presets are the default deployment's alone.
    expect(presetIds).not.toEqual(expect.arrayContaining(["pr-review"]));
    expect(presetIds).not.toContain("slack-channel");
    expect(presetIds).not.toContain("linear-triage");
    expect(
      defaultEventSource(
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toBe("gitlab");
  });

  it("moves every example draft onto what the restricted deployment offers", () => {
    for (const draft of [EMPTY_DRAFT, ...PRESETS.map((p) => p.apply(EMPTY_DRAFT))]) {
      const placed = draftForFeatures(
        draft,
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      );
      expect(STANDARD_TRIGGERS).toContain(placed.event.type);
      if (placed.trigger.type === "ticket" && placed.trigger.ticketSource) {
        expect(["gitlab", "jira"]).toContain(placed.trigger.ticketSource);
      }
    }
  });

  it("offers only Jira and GitLab as ticket sources", () => {
    expect(
      ticketSourcesFor(
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toEqual(["gitlab", "jira"]);
    expect(
      defaultTicketSource(
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toBe("gitlab");
    expect(
      automationChoices(
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ).ticketSources,
    ).toEqual(["gitlab", "jira"]);
    expect(
      ticketSourceOptions(
        BUILT_IN_TICKET_OPTIONS,
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ).map((o) => o.value),
    ).toEqual(["jira", "gitlab"]);
    expect(
      setupTrackerSources(
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toEqual(["jira"]);
  });

  it("offers only the restricted deployment's connection providers", () => {
    const offered = CATALOG.filter((p) =>
      galleryOffers(
        p.slug,
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).map((p) => p.slug);
    expect(offered.sort()).toEqual(["custom-http", "custom-mcp", "filesystem", "postgres"]);
    expect(
      serviceProviders(
        CATALOG,
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ).map((p) => p.slug),
    ).toEqual(expect.not.arrayContaining(["github-enhanced", "slack", "linear", "notion", "aws"]));
    // A workspace's own provider (not a built-in) is never hidden.
    expect(
      galleryOffers(
        "acme-internal",
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toBe(true);
  });

  it("keeps every list as it is under the default deployment", () => {
    expect(featureFilter("runtimes", AGENT_TYPES, featuresFromEnv({}))).toEqual([...AGENT_TYPES]);
    expect(whenTypesFor(featuresFromEnv({}))).toContain("github");
    expect(ticketSourcesFor(featuresFromEnv({}))[0]).toBe("github");
    expect(defaultEventSource(featuresFromEnv({}))).toBe("github");
    // The built-in list in its order, plus GitLab Issues (the API always took them).
    expect(ticketSourceOptions(BUILT_IN_TICKET_OPTIONS, featuresFromEnv({}))).toEqual([
      ...BUILT_IN_TICKET_OPTIONS,
      { value: "gitlab", label: "GitLab Issues" },
    ]);
    expect(setupTrackerSources(featuresFromEnv({}))).toEqual(["linear", "notion", "jira"]);
    expect(CATALOG.every((p) => galleryOffers(p.slug, featuresFromEnv({})))).toBe(true);
    expect(automationChoices(featuresFromEnv({})).presetIds).toContain("pr-review");
    expect(draftForFeatures(EMPTY_DRAFT, featuresFromEnv({}))).toBe(EMPTY_DRAFT);
  });
});
