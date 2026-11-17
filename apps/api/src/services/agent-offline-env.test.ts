import { describe, expect, it } from "vitest";
import { AGENT_OFFLINE_ENV, isAgentOffline, withAgentOfflineEnv } from "./agent-offline-env.js";

describe("isAgentOffline", () => {
  it("is off unless OPTIO_AGENT_OFFLINE says true", () => {
    expect(isAgentOffline({})).toBe(false);
    expect(isAgentOffline({ OPTIO_AGENT_OFFLINE: "" })).toBe(false);
    expect(isAgentOffline({ OPTIO_AGENT_OFFLINE: "false" })).toBe(false);
    expect(isAgentOffline({ OPTIO_AGENT_OFFLINE: "maybe" })).toBe(false);
    for (const on of ["true", "TRUE", " 1 ", "yes", "on"]) {
      expect(isAgentOffline({ OPTIO_AGENT_OFFLINE: on })).toBe(true);
    }
  });
});

describe("withAgentOfflineEnv", () => {
  const podEnv = { OPTIO_REPO_URL: "https://git.example.com/org/repo" };

  it("leaves a pod's env as it is when off (the default)", () => {
    expect(withAgentOfflineEnv(podEnv, {})).toBe(podEnv);
  });

  it("adds the offline baseline when on", () => {
    const env = withAgentOfflineEnv(podEnv, { OPTIO_AGENT_OFFLINE: "true" });
    expect(env).toEqual({ ...AGENT_OFFLINE_ENV, ...podEnv });
    expect(env).toMatchObject({
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_AUTOUPDATER: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      GH_NO_UPDATE_NOTIFIER: "1",
      GLAB_CHECK_UPDATE: "false",
      npm_config_update_notifier: "false",
    });
  });

  it("lets a pod's own value win over the baseline", () => {
    const env = withAgentOfflineEnv(
      { ...podEnv, OPENCODE_DISABLE_MODELS_FETCH: "false" },
      { OPTIO_AGENT_OFFLINE: "true" },
    );
    expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe("false");
    expect(env.DISABLE_TELEMETRY).toBe("1");
  });

  it("holds only plain string values the agent images can read", () => {
    for (const [name, value] of Object.entries(AGENT_OFFLINE_ENV)) {
      expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      expect(typeof value).toBe("string");
    }
    expect(Object.isFrozen(AGENT_OFFLINE_ENV)).toBe(true);
  });
});
