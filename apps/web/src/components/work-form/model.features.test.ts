import { featuresFromEnv } from "@optio/shared/features";
import { describe as suite, it, expect } from "vitest";
import {
  EMPTY_DRAFT,
  PRESETS,
  TERMINAL,
  WHEN_TYPES,
  draftForFeatures,
  whenTypesFor,
  type WorkDraft,
} from "./model";

suite("When answers by deployment features", () => {
  it("keeps every When by default", () => {
    expect(whenTypesFor(featuresFromEnv({}))).toEqual(WHEN_TYPES);
  });

  it("offers the restricted deployment's: no GitHub, Slack, Linear or SaaS alerting", () => {
    expect(
      whenTypesFor(
        featuresFromEnv({
          OPTIO_RUNTIMES: "claude-code,opencode",
          OPTIO_GIT_PLATFORMS: "gitlab",
          OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
          OPTIO_TICKET_SOURCES: "gitlab,jira",
          OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
        }),
      ),
    ).toEqual([
      "manual",
      "schedule",
      "webhook",
      "ticket",
      "gitlab",
      "jira",
      "sentry",
      "alertmanager",
    ]);
  });

  it("moves an example onto GitLab with GitLab selected and leaves it alone by default", () => {
    const assign = PRESETS.find((p) => p.id === "assign")!.apply(EMPTY_DRAFT);
    expect(assign.trigger.ticketSource).toBe("github");
    expect(draftForFeatures(assign, featuresFromEnv({}))).toBe(assign);
    const standard = draftForFeatures(
      assign,
      featuresFromEnv({
        OPTIO_RUNTIMES: "claude-code,opencode",
        OPTIO_GIT_PLATFORMS: "gitlab",
        OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
        OPTIO_TICKET_SOURCES: "gitlab,jira",
        OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
      }),
    );
    expect(standard.trigger.ticketSource).toBe("gitlab");
    expect(standard.event.type).toBe("gitlab");
    expect(standard.event.config).toEqual({
      events: ["review_requested", "mentioned"],
      username: "",
    });
  });

  it("moves an agent the restricted deployment doesn't offer onto Claude Code", () => {
    const codex: WorkDraft = { ...EMPTY_DRAFT, runtime: "codex", agentOptions: { model: "x" } };
    expect(draftForFeatures(codex, featuresFromEnv({}))).toBe(codex);
    const standard = draftForFeatures(
      codex,
      featuresFromEnv({
        OPTIO_RUNTIMES: "claude-code,opencode",
        OPTIO_GIT_PLATFORMS: "gitlab",
        OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
        OPTIO_TICKET_SOURCES: "gitlab,jira",
        OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
      }),
    );
    expect(standard.runtime).toBe("claude-code");
    expect(standard.agentOptions).toEqual({});
    const opencode: WorkDraft = { ...EMPTY_DRAFT, runtime: "opencode" };
    expect(
      draftForFeatures(
        opencode,
        featuresFromEnv({
          OPTIO_RUNTIMES: "claude-code,opencode",
          OPTIO_GIT_PLATFORMS: "gitlab",
          OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
          OPTIO_TICKET_SOURCES: "gitlab,jira",
          OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
        }),
      ).runtime,
    ).toBe("opencode");
    const terminal: WorkDraft = { ...EMPTY_DRAFT, runtime: TERMINAL };
    expect(
      draftForFeatures(
        terminal,
        featuresFromEnv({
          OPTIO_RUNTIMES: "claude-code,opencode",
          OPTIO_GIT_PLATFORMS: "gitlab",
          OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
          OPTIO_TICKET_SOURCES: "gitlab,jira",
          OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
        }),
      ).runtime,
    ).toBe(TERMINAL);
  });
});

suite("independent feature lists in fresh drafts", () => {
  it("chooses an offered runtime and event rather than assuming Claude Code or GitLab", () => {
    const features = featuresFromEnv({ OPTIO_RUNTIMES: "codex", OPTIO_TRIGGERS: "schedule,slack" });
    const draft = draftForFeatures({ ...EMPTY_DRAFT, when: "github" }, features);
    expect(draft.runtime).toBe("codex");
    expect(draft.when).toBe("schedule");
    expect(draft.event.type).toBe("slack");
    expect(draft.agentOptions).toEqual({});
  });
});
