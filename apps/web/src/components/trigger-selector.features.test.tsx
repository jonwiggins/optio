import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// The deployment's feature lists (default: everything); tests pick the restricted deployment's.
let features = featuresFromEnv({});
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ features, loaded: true }),
}));

import { TriggerSelector, defaultTicketSource, ticketSourcesFor } from "./trigger-selector";

afterEach(() => {
  cleanup();
  features = featuresFromEnv({});
});

describe("TriggerSelector under the restricted deployment", () => {
  it("offers the restricted deployment's ticket sources, GitLab first", () => {
    features = featuresFromEnv({
      OPTIO_RUNTIMES: "claude-code,opencode",
      OPTIO_GIT_PLATFORMS: "gitlab",
      OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
      OPTIO_TICKET_SOURCES: "gitlab,jira",
      OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
    });
    render(
      <TriggerSelector
        value={{ type: "ticket", ticketSource: "gitlab", ticketLabels: [] }}
        onChange={vi.fn()}
      />,
    );
    const select = screen.getByLabelText(/source/i) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["gitlab", "jira"]);
  });

  it("starts a new ticket trigger on GitLab, not GitHub", () => {
    features = featuresFromEnv({
      OPTIO_RUNTIMES: "claude-code,opencode",
      OPTIO_GIT_PLATFORMS: "gitlab",
      OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
      OPTIO_TICKET_SOURCES: "gitlab,jira",
      OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
    });
    const onChange = vi.fn();
    render(<TriggerSelector value={{ type: "manual" }} onChange={onChange} />);
    fireEvent.click(screen.getByText("Ticket"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ticket", ticketSource: "gitlab" }),
    );
  });

  it("keeps a saved source the trigger list no longer offers selectable", () => {
    features = featuresFromEnv({
      OPTIO_RUNTIMES: "claude-code,opencode",
      OPTIO_GIT_PLATFORMS: "gitlab",
      OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
      OPTIO_TICKET_SOURCES: "gitlab,jira",
      OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
    });
    render(
      <TriggerSelector
        value={{ type: "ticket", ticketSource: "linear", ticketLabels: [] }}
        onChange={vi.fn()}
      />,
    );
    const select = screen.getByLabelText(/source/i) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["gitlab", "jira", "linear"]);
    expect(select.value).toBe("linear");
  });

  it("names the sources per features (pure)", () => {
    expect(
      ticketSourcesFor(
        featuresFromEnv({
          OPTIO_RUNTIMES: "claude-code,opencode",
          OPTIO_GIT_PLATFORMS: "gitlab",
          OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
          OPTIO_TICKET_SOURCES: "gitlab,jira",
          OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
        }),
      ),
    ).toEqual(["gitlab", "jira"]);
    expect(
      defaultTicketSource(
        featuresFromEnv({
          OPTIO_RUNTIMES: "claude-code,opencode",
          OPTIO_GIT_PLATFORMS: "gitlab",
          OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
          OPTIO_TICKET_SOURCES: "gitlab,jira",
          OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
        }),
      ),
    ).toBe("gitlab");
    expect(ticketSourcesFor(featuresFromEnv({}))).toEqual([
      "github",
      "gitlab",
      "linear",
      "jira",
      "notion",
    ]);
    expect(defaultTicketSource(featuresFromEnv({}))).toBe("github");
  });
});
