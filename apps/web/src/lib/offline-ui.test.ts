import { describe, it, expect, afterEach } from "vitest";
import { displayableImageUrl, isOfflineUi, offlineUiConfig, deploymentOrigins } from "./offline-ui";

const ORIGINS = ["https://optio.example.com", "https://api.optio.example.com"];

afterEach(() => {
  delete (window as any).__OPTIO_CONFIG;
});

describe("offlineUiConfig", () => {
  it("adds offlineUi only when OPTIO_OFFLINE_UI is true", () => {
    expect(offlineUiConfig({})).toEqual({});
    expect(offlineUiConfig({ OPTIO_OFFLINE_UI: "false" })).toEqual({});
    expect(offlineUiConfig({ OPTIO_OFFLINE_UI: "1" })).toEqual({});
    expect(offlineUiConfig({ OPTIO_OFFLINE_UI: "true" })).toEqual({ offlineUi: true });
    expect(offlineUiConfig({ OPTIO_OFFLINE_UI: " TRUE " })).toEqual({ offlineUi: true });
  });
});

describe("isOfflineUi", () => {
  it("follows what the layout injected", () => {
    expect(isOfflineUi()).toBe(false);
    (window as any).__OPTIO_CONFIG = { offlineUi: true };
    expect(isOfflineUi()).toBe(true);
    (window as any).__OPTIO_CONFIG = { offlineUi: "true" };
    expect(isOfflineUi()).toBe(false);
  });
});

describe("deploymentOrigins", () => {
  it("is the page's origin and the API's", () => {
    (window as any).__OPTIO_CONFIG = { publicApiUrl: "https://api.optio.example.com/" };
    expect(deploymentOrigins()).toEqual([window.location.origin, "https://api.optio.example.com"]);
    (window as any).__OPTIO_CONFIG = { publicApiUrl: "not a url" };
    expect(deploymentOrigins()).toEqual([window.location.origin]);
  });
});

describe("displayableImageUrl", () => {
  const gravatar = "https://www.gravatar.com/avatar/0123456789abcdef?s=80&d=identicon";

  it("leaves every URL alone with the setting off", () => {
    expect(displayableImageUrl(gravatar, false, ORIGINS)).toBe(gravatar);
    expect(displayableImageUrl(null, false, ORIGINS)).toBeNull();
  });

  it("with the setting on, keeps only images on the deployment's own origins", () => {
    expect(displayableImageUrl(gravatar, true, ORIGINS)).toBeNull();
    expect(
      displayableImageUrl("https://avatars.githubusercontent.com/u/1?v=4", true, ORIGINS),
    ).toBeNull();
    expect(displayableImageUrl("https://api.optio.example.com/uploads/me.png", true, ORIGINS)).toBe(
      "https://api.optio.example.com/uploads/me.png",
    );
    expect(displayableImageUrl("/uploads/me.png", true, ORIGINS)).toBe("/uploads/me.png");
    expect(displayableImageUrl("data:image/png;base64,AAAA", true, ORIGINS)).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it("is not fooled by look-alike hosts, other ports or schemes", () => {
    for (const url of [
      "https://optio.example.com.attacker.example/a.png",
      "https://optio.example.com:8443/a.png",
      "http://optio.example.com/a.png",
      "//gravatar.com/avatar/x",
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
    ]) {
      expect(displayableImageUrl(url, true, ORIGINS), url).toBeNull();
    }
  });
});
