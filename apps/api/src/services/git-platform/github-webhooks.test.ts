import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoIdentifier } from "@optio/shared";
import { GitHubApiError, GitHubPlatform } from "./github.js";

/** The repository webhook Optio keeps on a GitHub repo (opt-in, repo-webhook-service.ts). */

const ri: RepoIdentifier = {
  platform: "github",
  host: "github.com",
  owner: "acme",
  repo: "widgets",
  apiBaseUrl: "https://api.github.com",
};
const HOOKS = "https://api.github.com/repos/acme/widgets/hooks";
const spec = {
  url: "https://optio.example.test/api/webhooks/github",
  token: "gh-secret",
  events: ["push", "pull_request"],
};

const mockFetch = vi.fn();
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

let original: typeof fetch;
beforeEach(() => {
  original = globalThis.fetch;
  globalThis.fetch = mockFetch as never;
  mockFetch.mockReset();
});
afterEach(() => {
  globalThis.fetch = original;
});

describe("GitHubPlatform.ensureWebhook", () => {
  it("creates a JSON hook signed with the secret when none points at Optio", async () => {
    mockFetch.mockResolvedValueOnce(json([{ id: 1, config: { url: "https://ci.example.test" } }]));
    mockFetch.mockResolvedValueOnce(json({ id: 55 }, 201));

    const out = await new GitHubPlatform("ghp_x").ensureWebhook(ri, spec);

    expect(out).toEqual({ hookId: "55", created: true });
    expect(mockFetch.mock.calls[0][0]).toBe(`${HOOKS}?per_page=100`);
    const [url, init] = mockFetch.mock.calls[1];
    expect(url).toBe(HOOKS);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer ghp_x");
    expect(JSON.parse(init.body)).toEqual({
      name: "web",
      active: true,
      events: ["push", "pull_request"],
      config: {
        url: spec.url,
        content_type: "json",
        secret: "gh-secret",
        insecure_ssl: "0",
      },
    });
  });

  it("brings the hook at Optio's URL (or the one it made before) up to date", async () => {
    mockFetch.mockResolvedValueOnce(json([{ id: 7, config: { url: "https://old.example.test" } }]));
    mockFetch.mockResolvedValueOnce(json({ id: 7 }));

    const out = await new GitHubPlatform("ghp_x").ensureWebhook(ri, { ...spec, hookId: "7" });

    expect(out).toEqual({ hookId: "7", created: false });
    expect(mockFetch.mock.calls[1][0]).toBe(`${HOOKS}/7`);
    expect(mockFetch.mock.calls[1][1].method).toBe("PATCH");
  });

  it("passes GitHub's refusal on", async () => {
    mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    await expect(new GitHubPlatform("ghp_x").ensureWebhook(ri, spec)).rejects.toBeInstanceOf(
      GitHubApiError,
    );
  });
});

describe("GitHubPlatform.deleteWebhook", () => {
  it("deletes the hook, and a hook already gone is fine", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await new GitHubPlatform("ghp_x").deleteWebhook(ri, "55");
    expect(mockFetch.mock.calls[0][0]).toBe(`${HOOKS}/55`);
    expect(mockFetch.mock.calls[0][1].method).toBe("DELETE");

    mockFetch.mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(new GitHubPlatform("ghp_x").deleteWebhook(ri, "55")).resolves.toBeUndefined();

    mockFetch.mockResolvedValueOnce(new Response("", { status: 500 }));
    await expect(new GitHubPlatform("ghp_x").deleteWebhook(ri, "55")).rejects.toThrow();
  });
});
