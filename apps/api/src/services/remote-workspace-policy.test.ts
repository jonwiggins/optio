import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted((): { stored: unknown; error: boolean } => ({
  stored: undefined,
  error: false,
}));
vi.mock("./deployment-settings.js", async (original) => ({
  ...(await original<typeof import("./deployment-settings.js")>()),
  getDeploymentSetting: async () => {
    if (state.error) throw new Error("database unavailable");
    return state.stored;
  },
}));
import { remoteWorkspacesEnabled, remoteWorkspacesPolicy } from "./remote-workspace-policy.js";
beforeEach(() => {
  vi.unstubAllEnvs();
  state.stored = undefined;
  state.error = false;
});
describe("remote workspace protective opt-in", () => {
  it("is off by default and enables only by an operator's env or saved setting", async () => {
    expect(await remoteWorkspacesEnabled()).toBe(false);
    vi.stubEnv("OPTIO_REMOTE_WORKSPACES", "true");
    expect(await remoteWorkspacesEnabled()).toBe(true);
    state.stored = false;
    expect(await remoteWorkspacesPolicy()).toEqual({
      value: false,
      source: "app",
      environment: true,
    });
    state.stored = true;
    expect(await remoteWorkspacesEnabled()).toBe(true);
  });
  it("fails closed on a database error even when the environment enables it", async () => {
    vi.stubEnv("OPTIO_REMOTE_WORKSPACES", "true");
    state.error = true;
    expect(await remoteWorkspacesEnabled()).toBe(false);
    await expect(remoteWorkspacesPolicy()).rejects.toThrow("database unavailable");
  });
});

afterEach(() => vi.unstubAllEnvs());

it("blocks both Coder and the other providers before credential-bearing HTTP on read failure", async () => {
  const { CoderClient } = await import("./remote-workspaces/coder.js");
  const { providerHttp } = await import("./remote-workspaces/http.js");
  const { setOutboundDefaults } = await import("../utils/outbound-url.js");
  const send = vi.fn();
  const restore = setOutboundDefaults({ fetchImpl: send });
  vi.stubEnv("OPTIO_REMOTE_WORKSPACES", "true");
  state.error = true;
  try {
    await expect(
      new CoderClient({ url: "https://coder.example", token: "private-coder-token" }).me(),
    ).rejects.toThrow(/disabled/);
    await expect(
      providerHttp(
        "E2B",
        { url: "https://api.e2b.dev", token: "private-e2b-token" },
        { "X-API-Key": "private-e2b-token" },
      ).json("GET", "/sandboxes"),
    ).rejects.toThrow(/disabled/);
    expect(send).not.toHaveBeenCalled();
  } finally {
    restore();
  }
});
