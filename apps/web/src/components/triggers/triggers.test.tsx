import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  EventTriggerDetails,
  eventTriggerSummary,
  pagerDutyKindLabel,
} from "./event-trigger-details";
import { newTriggerSecret, pylonHookUrl, PylonSecretDialog } from "./pylon-secret-dialog";

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
  });

  it("labels PagerDuty kinds readably, falling back for unknown ones", () => {
    expect(pagerDutyKindLabel("incident.acknowledged")).toBe("Acknowledged");
    expect(pagerDutyKindLabel("incident.responder.added")).toBe("Responder added");
    expect(pagerDutyKindLabel("incident.something_new")).toBe("something new");
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
