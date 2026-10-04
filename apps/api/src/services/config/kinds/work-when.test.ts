import { describe, expect, it } from "vitest";
import type { WorkWhenManifest } from "@optio/shared";
import { whenFromManifest, whenToManifest } from "./work-when.js";

describe("Work `when`", () => {
  it("maps each manifest shape to the trigger the API stores, and back", () => {
    expect(whenFromManifest(undefined)).toEqual({ type: "manual" });
    expect(whenFromManifest({ schedule: "0 3 * * *" })).toEqual({
      type: "schedule",
      config: { cronExpression: "0 3 * * *" },
    });
    expect(whenFromManifest({ schedule: { cron: "@daily" } })).toEqual({
      type: "schedule",
      config: { cronExpression: "@daily" },
    });
    expect(whenFromManifest({ webhook: { path: "nightly" } })).toEqual({
      type: "webhook",
      config: { path: "nightly" },
    });
    expect(whenFromManifest({ ticket: { source: "github", labels: ["optio"] } })).toEqual({
      type: "ticket",
      config: { source: "github", labels: ["optio"] },
    });
    expect(whenFromManifest({ github: { events: ["pr_opened"], repos: ["acme/api"] } })).toEqual({
      type: "github",
      config: { events: ["pr_opened"], repos: ["acme/api"] },
    });
  });

  it("writes a stored trigger as a manifest's `when`, never a webhook's secret", () => {
    expect(whenToManifest(null)).toBeUndefined();
    expect(whenToManifest({ type: "schedule", config: { cronExpression: "0 3 * * *" } })).toEqual({
      schedule: "0 3 * * *",
    });
    expect(whenToManifest({ type: "webhook", config: { path: "nightly", secret: "shh" } })).toEqual(
      {
        webhook: { path: "nightly" },
      },
    );
    expect(whenToManifest({ type: "ticket", config: { source: "linear", labels: [] } })).toEqual({
      ticket: { source: "linear" },
    });
    expect(whenToManifest({ type: "slack", config: { channelId: "C123" } })).toEqual({
      slack: { channelId: "C123" },
    });
  });

  it("round-trips", () => {
    for (const when of [
      { schedule: "0 3 * * 1-5" },
      { webhook: { path: "p" } },
      { ticket: { source: "github", labels: ["a"] } },
      { linear: { events: ["issue_created"], user: "me" } },
    ] as WorkWhenManifest[]) {
      expect(whenToManifest(whenFromManifest(when) as { type: string; config: unknown })).toEqual(
        when,
      );
    }
  });
});
