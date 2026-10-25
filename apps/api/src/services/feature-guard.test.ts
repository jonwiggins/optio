import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  FeatureUnavailableError,
  assertConnectionProviderAllowed,
  assertPlatformAllowed,
  assertRuntimeAllowed,
  assertTicketSourceAllowed,
  assertTriggerAllowed,
  connectionProviderRefusal,
  offeredProviderIds,
  featureRefusal,
  providerAllowed,
  receiverFor,
  refineFeature,
  runtimeRefusal,
} from "./feature-guard.js";

const FEATURE_ENV = [
  "OPTIO_RUNTIMES",
  "OPTIO_GIT_PLATFORMS",
  "OPTIO_TRIGGERS",
  "OPTIO_TICKET_SOURCES",
  "OPTIO_CONNECTION_PROVIDERS",
  "OPTIO_FEATURE_PRESET",
];

beforeEach(() => {
  for (const name of FEATURE_ENV) vi.stubEnv(name, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Lists narrowed the way an admin might: two runtimes, GitLab, the receive-only triggers. */
function narrow(): void {
  vi.stubEnv("OPTIO_RUNTIMES", "claude-code,opencode");
  vi.stubEnv("OPTIO_GIT_PLATFORMS", "gitlab");
  vi.stubEnv("OPTIO_TRIGGERS", "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager");
  vi.stubEnv("OPTIO_TICKET_SOURCES", "gitlab,jira");
  vi.stubEnv("OPTIO_CONNECTION_PROVIDERS", "postgres,filesystem,custom-http,custom-mcp");
}

describe("feature-guard with nothing set (upstream's behaviour)", () => {
  it("refuses nothing upstream offers", () => {
    for (const r of [
      "claude-code",
      "codex",
      "copilot",
      "opencode",
      "gemini",
      "openclaw",
      "cursor",
    ]) {
      expect(() => assertRuntimeAllowed(r)).not.toThrow();
    }
    expect(() => assertPlatformAllowed("github")).not.toThrow();
    expect(() => assertPlatformAllowed("codecommit")).not.toThrow();
    expect(() => assertTicketSourceAllowed("notion")).not.toThrow();
    expect(connectionProviderRefusal("github-enhanced")).toBeNull();
    expect(connectionProviderRefusal("aws")).toBeNull();
    expect(offeredProviderIds()).toHaveLength(7);
  });

  it("registers every trigger receiver", () => {
    for (const t of [
      "github",
      "gitlab",
      "slack",
      "linear",
      "jira",
      "pylon",
      "pagerduty",
      "sentry",
      "alertmanager",
      "datadog",
    ]) {
      expect(() => assertTriggerAllowed(t)).not.toThrow();
      const app = { post: vi.fn() };
      expect(receiverFor(app, t)).toBe(app);
    }
  });
});

describe("feature-guard with lists an admin narrowed", () => {
  it("refuses what the lists leave out, by name", () => {
    narrow();
    expect(runtimeRefusal("codex")).toBe("codex isn't available in this deployment");
    expect(() => assertRuntimeAllowed("cursor")).toThrow(FeatureUnavailableError);
    expect(() => assertPlatformAllowed("github")).toThrow(
      "github isn't available in this deployment",
    );
    expect(() => assertTriggerAllowed("slack")).toThrow(FeatureUnavailableError);
    for (const t of ["github", "linear", "pylon", "pagerduty", "datadog"]) {
      expect(() => assertTriggerAllowed(t)).toThrow(`${t} isn't available in this deployment`);
    }
    expect(() => assertTicketSourceAllowed("linear")).toThrow(FeatureUnavailableError);
    expect(() => assertConnectionProviderAllowed("notion")).toThrow(FeatureUnavailableError);
    try {
      assertRuntimeAllowed("gemini");
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 400, feature: "runtimes", value: "gemini" });
    }
  });

  it("lets through what the lists keep, nothing chosen, and values Optio doesn't know", () => {
    narrow();
    for (const v of ["claude-code", "opencode", null, undefined, ""]) {
      expect(() => assertRuntimeAllowed(v)).not.toThrow();
    }
    expect(() => assertPlatformAllowed("gitlab")).not.toThrow();
    for (const t of [
      "manual",
      "schedule",
      "webhook",
      "ticket",
      "gitlab",
      "jira",
      "sentry",
      "alertmanager",
    ]) {
      expect(() => assertTriggerAllowed(t)).not.toThrow();
    }
    expect(() => assertTicketSourceAllowed("jira")).not.toThrow();
    for (const p of ["postgres", "filesystem", "custom-http", "custom-mcp"]) {
      expect(() => assertConnectionProviderAllowed(p)).not.toThrow();
    }
    // An unknown value is the caller's own validation's to answer.
    expect(featureRefusal("runtimes", "made-up")).toBeNull();
  });

  it("narrows one list alone: the others still offer everything", () => {
    vi.stubEnv("OPTIO_RUNTIMES", "codex");
    expect(runtimeRefusal("claude-code")).toBe("claude-code isn't available in this deployment");
    expect(() => assertPlatformAllowed("github")).not.toThrow();
    expect(() => assertTriggerAllowed("slack")).not.toThrow();
  });

  it("refuses the GitHub connection under its built-in slug", () => {
    narrow();
    expect(connectionProviderRefusal("github-enhanced")).toBe(
      "github-enhanced isn't available in this deployment",
    );
  });

  it("offers only the offered runtimes' provider catalogs", () => {
    narrow();
    expect(offeredProviderIds()).toEqual(["anthropic", "opencode"]);
    expect(providerAllowed("openai")).toBe(false);
    expect(providerAllowed("anthropic")).toBe(true);
  });

  it("refines a zod schema with the refusal message", () => {
    narrow();
    const schema = z.string().superRefine(refineFeature("runtimes"));
    const res = schema.safeParse("codex");
    expect(res.success).toBe(false);
    expect(res.error?.issues[0].message).toBe("codex isn't available in this deployment");
    expect(schema.safeParse("claude-code").success).toBe(true);
  });

  it("never registers a receiver for a trigger OPTIO_TRIGGERS leaves out", () => {
    narrow();
    const app = { post: vi.fn() };
    receiverFor(app, "slack").post("/x");
    expect(app.post).not.toHaveBeenCalled();
    expect(receiverFor(app, "gitlab")).toBe(app);
  });

  it("the minimal preset fills the lists left unset", () => {
    vi.stubEnv("OPTIO_FEATURE_PRESET", "minimal");
    vi.stubEnv("OPTIO_RUNTIMES", "codex");
    expect(runtimeRefusal("codex")).toBeNull();
    expect(runtimeRefusal("claude-code")).toBe("claude-code isn't available in this deployment");
    expect(() => assertPlatformAllowed("github")).toThrow(FeatureUnavailableError);
    expect(() => assertTriggerAllowed("slack")).toThrow(FeatureUnavailableError);
  });
});
