import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  EVENT_KINDS,
  EventTriggerDetails,
  IDENTITY_KEY,
  eventKindLabel,
  eventTriggerSummary,
  pagerDutyKindLabel,
} from "./event-trigger-details";
import {
  TriggerSecretDialog,
  hookUrl,
  newTriggerSecret,
  pylonHookUrl,
  PylonSecretDialog,
} from "./pylon-secret-dialog";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

describe("event trigger summaries", () => {
  it("say what each source listens for, never the raw config", () => {
    expect(
      eventTriggerSummary("github", { events: ["pr_opened"], login: "octocat", repos: ["a/b"] }),
    ).toBe("pr_opened → @octocat in a/b");
    expect(eventTriggerSummary("slack", { channelId: "C1", mentionOnly: true })).toBe(
      "C1 (@-mentions)",
    );
    expect(eventTriggerSummary("linear", { events: [], othersOnly: true })).toBe(
      "any event · from others",
    );
    expect(
      eventTriggerSummary("pagerduty", {
        events: ["incident.triggered", "incident.priority_updated"],
        services: ["Checkout API"],
        urgency: "high",
      }),
    ).toBe("Triggered, Priority updated on Checkout API · high urgency");
    expect(eventTriggerSummary("pagerduty", {})).toBe("any incident event");
    expect(eventTriggerSummary("pylon", { events: ["issue.created"], hasSecret: true })).toBe(
      "issue.created",
    );
    expect(eventTriggerSummary("pylon", null)).toBe("any event");
    expect(eventTriggerSummary("schedule", { cronExpression: "* * * * *" })).toBe("");
    // The newer sources.
    expect(
      eventTriggerSummary("github", {
        events: ["workflow_failed"],
        branches: ["main"],
        labels: ["bug"],
      }),
    ).toBe("workflow_failed on main · bug");
    expect(
      eventTriggerSummary("gitlab", {
        events: ["mr_opened", "push"],
        username: "ada",
        projects: ["acme/app"],
        branches: ["main"],
      }),
    ).toBe("mr_opened, push → @ada in acme/app on main");
    expect(
      eventTriggerSummary("jira", {
        events: ["transitioned"],
        projects: ["ENG"],
        statuses: ["Done"],
        issueTypes: ["Bug"],
      }),
    ).toBe("transitioned in ENG · Bug → Done");
    expect(
      eventTriggerSummary("sentry", {
        events: ["issue_created", "alert_triggered"],
        projects: ["backend"],
        levels: ["error"],
      }),
    ).toBe("New issue, Issue alert fires in backend · error");
    expect(eventTriggerSummary("sentry", {})).toBe("any Sentry event");
    expect(
      eventTriggerSummary("alertmanager", {
        events: ["firing"],
        alertnames: ["HighErrorRate"],
        severities: ["critical"],
        hasSecret: true,
      }),
    ).toBe("Alerts firing · HighErrorRate · critical");
    expect(eventTriggerSummary("alertmanager", null)).toBe("firing or resolved");
    expect(
      eventTriggerSummary("datadog", {
        events: ["triggered", "recovered"],
        priorities: ["P1"],
        tags: ["service:checkout"],
        monitors: ["Checkout latency"],
      }),
    ).toBe("Monitor triggered, Monitor recovered · P1 · service:checkout on Checkout latency");
    expect(eventTriggerSummary("datadog", {})).toBe("any transition");
  });

  it("labels PagerDuty kinds readably, falling back for unknown ones", () => {
    expect(pagerDutyKindLabel("incident.acknowledged")).toBe("Acknowledged");
    expect(pagerDutyKindLabel("incident.responder.added")).toBe("Responder added");
    expect(pagerDutyKindLabel("incident.something_new")).toBe("something new");
    expect(eventKindLabel("gitlab", "pipeline_failed")).toBe("A pipeline fails");
    expect(eventKindLabel("jira", "transitioned")).toBe("Status changes");
    expect(eventKindLabel("sentry", "metric_alert_critical")).toBe("Metric alert critical");
    expect(eventKindLabel("datadog", "no_data")).toBe("No data");
    expect(eventKindLabel("datadog", "brand_new")).toBe("brand new");
  });

  it("offers a checklist for every source but Slack and Pylon, with personal kinds only where an identity exists", () => {
    expect(EVENT_KINDS.slack).toEqual([]);
    expect(EVENT_KINDS.pylon).toEqual([]);
    for (const type of ["github", "gitlab", "linear", "jira"]) {
      expect(EVENT_KINDS[type].some((k) => k.personal)).toBe(true);
      expect(IDENTITY_KEY[type]).toBeTruthy();
    }
    for (const type of ["pagerduty", "sentry", "alertmanager", "datadog"]) {
      expect(EVENT_KINDS[type].length).toBeGreaterThan(0);
      expect(EVENT_KINDS[type].some((k) => k.personal)).toBe(false);
      expect(IDENTITY_KEY[type]).toBeNull();
    }
    expect(EVENT_KINDS.github.map((k) => k.value)).toEqual(
      expect.arrayContaining(["pr_merged", "push", "release_published", "workflow_failed"]),
    );
    expect(IDENTITY_KEY.gitlab).toBe("username");
    expect(IDENTITY_KEY.jira).toBe("user");
  });
});

describe("Pylon secrets", () => {
  it("mints 32 random bytes as base64url", () => {
    const a = newTriggerSecret();
    const b = newTriggerSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("builds the per-trigger ingress URL", () => {
    expect(pylonHookUrl("t-1", "https://optio.example")).toBe(
      "https://optio.example/api/hooks/pylon/t-1",
    );
  });

  it("the dialog shows the URL, header, and secret once, and Done hands back", () => {
    const onDone = vi.fn();
    render(<PylonSecretDialog triggerId="t-1" secret="s3cret" onDone={onDone} />);
    expect(screen.getByText("Pylon is listening")).toBeTruthy();
    expect(screen.getByText(/\/api\/hooks\/pylon\/t-1$/)).toBeTruthy();
    expect(screen.getByText("X-Optio-Secret")).toBeTruthy();
    expect(screen.getByTestId("pylon-secret-value").textContent).toBe("s3cret");
    expect(screen.getByText("This is the only time the secret is shown.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("pylon-secret-done"));
    expect(onDone).toHaveBeenCalled();
  });

  it("details show Secret set without the secret, and Regenerate PATCHes a new one", async () => {
    const updateConfig = vi.fn(async () => {});
    render(
      <EventTriggerDetails
        trigger={{ id: "t-1", type: "pylon", config: { events: ["x"], hasSecret: true } }}
        updateConfig={updateConfig}
      />,
    );
    expect(screen.getByTestId("pylon-secret-state").textContent).toBe("Secret set");
    expect(screen.getByText(/\/api\/hooks\/pylon\/t-1$/)).toBeTruthy();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByText("Regenerate"));
    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    const config = updateConfig.mock.calls[0]![0] as Record<string, unknown>;
    expect(config.events).toEqual(["x"]);
    expect(config).not.toHaveProperty("hasSecret");
    expect(config.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The minted secret is shown once, in the same dialog.
    await waitFor(() =>
      expect(screen.getByTestId("pylon-secret-value").textContent).toBe(config.secret),
    );
  });

  it("other event triggers get a one-line summary", () => {
    render(
      <EventTriggerDetails
        trigger={{ id: "t-2", type: "pagerduty", config: { events: ["incident.resolved"] } }}
      />,
    );
    expect(screen.getByText("Resolved")).toBeTruthy();
    expect(screen.queryByTestId("pylon-trigger-details")).toBeNull();
  });
});

describe("Alertmanager and Datadog secrets", () => {
  it("each self-secret type has its own ingress URL", () => {
    expect(hookUrl("alertmanager", "t-1", "https://optio.example")).toBe(
      "https://optio.example/api/hooks/alertmanager/t-1",
    );
    expect(hookUrl("datadog", "t-1", "https://optio.example")).toBe(
      "https://optio.example/api/hooks/datadog/t-1",
    );
  });

  it("the Datadog dialog shows the URL, header, secret and payload template once", () => {
    const onDone = vi.fn();
    render(
      <TriggerSecretDialog type="datadog" triggerId="t-9" secret="dd-s3cret" onDone={onDone} />,
    );
    expect(screen.getByText("Datadog is listening")).toBeTruthy();
    expect(screen.getByText(/\/api\/hooks\/datadog\/t-9$/)).toBeTruthy();
    expect(screen.getByText("X-Optio-Secret")).toBeTruthy();
    expect(screen.getByTestId("datadog-secret-value").textContent).toBe("dd-s3cret");
    expect(screen.getByTestId("datadog-payload-template").textContent).toContain(
      '"alert_transition":"$ALERT_TRANSITION"',
    );
    fireEvent.click(screen.getByTestId("datadog-secret-done"));
    expect(onDone).toHaveBeenCalled();
    expect(screen.queryByTestId("pylon-secret-dialog")).toBeNull();
  });

  it("Alertmanager details show the URL and secret state, and Regenerate mints a new one", async () => {
    const updateConfig = vi.fn(async () => {});
    render(
      <EventTriggerDetails
        trigger={{
          id: "t-3",
          type: "alertmanager",
          config: { events: ["firing"], severities: ["critical"], hasSecret: true },
        }}
        updateConfig={updateConfig}
      />,
    );
    expect(screen.getByTestId("alertmanager-trigger-details")).toBeTruthy();
    expect(screen.getByTestId("alertmanager-secret-state").textContent).toBe("Secret set");
    expect(screen.getByText(/\/api\/hooks\/alertmanager\/t-3$/)).toBeTruthy();
    expect(screen.getByText("Events: Alerts firing · critical")).toBeTruthy();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByText("Regenerate"));
    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    const config = updateConfig.mock.calls[0]![0] as Record<string, unknown>;
    expect(config.events).toEqual(["firing"]);
    expect(config.severities).toEqual(["critical"]);
    expect(config).not.toHaveProperty("hasSecret");
    expect(config.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await waitFor(() =>
      expect(screen.getByTestId("alertmanager-secret-value").textContent).toBe(config.secret),
    );
  });

  it("signed sources (GitLab, Jira, Sentry) get a summary, not a secret", () => {
    render(
      <EventTriggerDetails
        trigger={{ id: "t-4", type: "sentry", config: { events: ["issue_resolved"] } }}
      />,
    );
    expect(screen.getByText("Issue resolved")).toBeTruthy();
    expect(screen.queryByTestId("sentry-trigger-details")).toBeNull();
  });
});
