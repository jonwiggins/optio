import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLatestVersion,
  getVersionInfo,
  isUpdateCheckEnabled,
  resetVersionCache,
} from "./version-service.js";

const fetchMock = vi.fn();

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => {
  resetVersionCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OPTIO_VERSION", "1.0.0");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("isUpdateCheckEnabled", () => {
  it("is on unless the environment says false", () => {
    expect(isUpdateCheckEnabled({})).toBe(true);
    expect(isUpdateCheckEnabled({ OPTIO_UPDATE_CHECK: "" })).toBe(true);
    expect(isUpdateCheckEnabled({ OPTIO_UPDATE_CHECK: "true" })).toBe(true);
    for (const off of ["false", "FALSE", " 0 ", "no", "off"]) {
      expect(isUpdateCheckEnabled({ OPTIO_UPDATE_CHECK: off })).toBe(false);
    }
  });
});

describe("getVersionInfo", () => {
  it("asks the registry when the check is on (upstream default)", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ token: "t" }))
      .mockResolvedValueOnce(json({ tags: ["0.9.0", "1.2.0", "latest", "1.1.0"] }));

    const info = await getVersionInfo();

    expect(info).toEqual({
      current: "1.0.0",
      latest: "1.2.0",
      updateAvailable: true,
      updateCheck: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("https://ghcr.io/token");
    // Each request gives up instead of hanging on a network that drops packets.
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("makes no outbound request when the check is off", async () => {
    vi.stubEnv("OPTIO_UPDATE_CHECK", "false");

    expect(await getVersionInfo()).toEqual({
      current: "1.0.0",
      latest: null,
      updateAvailable: false,
      updateCheck: false,
    });
    expect(await getLatestVersion()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports no update when the registry can't be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    expect(await getVersionInfo()).toEqual({
      current: "1.0.0",
      latest: null,
      updateAvailable: false,
      updateCheck: true,
    });
  });
});
