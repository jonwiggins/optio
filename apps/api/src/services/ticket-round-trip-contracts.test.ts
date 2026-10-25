import { afterEach, describe, expect, it, vi } from "vitest";
import { setGitLabTransport } from "@optio/shared";
import {
  githubRoundTrip,
  gitlabRoundTrip,
  gitLabRoundTripConfig,
  linearRoundTrip,
  notionRoundTrip,
} from "@optio/ticket-providers";
import { startFakeHttp } from "../test-utils/fake-http.js";

afterEach(() => {
  setGitLabTransport((url, init) => fetch(url, init));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ticket round-trip API contracts", () => {
  it("GitLab uses the configured transport, Bearer auth and the prefixed API root", async () => {
    vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "gitlab.example.test");
    const transport = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 42, username: "optio" })));
    setGitLabTransport(transport);
    await gitlabRoundTrip.whoAmI({
      token: "oauth-token",
      host: "https://gitlab.example.test:8443/GitLab/",
      projectPath: "g/p",
    });
    expect(transport).toHaveBeenCalledWith(
      "https://gitlab.example.test:8443/GitLab/api/v4/user",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({ Authorization: "Bearer oauth-token" }),
      }),
    );
  });

  it("a group ticket uses its saved project without changing the credential destination", () => {
    const config = { token: "t", host: "gitlab.example.test:8443/GitLab", groupPath: "g" };
    expect(
      gitLabRoundTripConfig(config, "https://gitlab.example.test:8443/GitLab/g/sub/p/-/issues/7"),
    ).toEqual({ ...config, projectPath: "g/sub/p" });
    for (const url of [
      "https://evil.example/GitLab/g/p/-/issues/7",
      "https://gitlab.example.test:9443/GitLab/g/p/-/issues/7",
      "http://gitlab.example.test:8443/GitLab/g/p/-/issues/7",
      "https://gitlab.example.test:8443/Other/g/p/-/issues/7",
      "https://gitlab.example.test:8443/GitLab/other/p/-/issues/7",
      "https://gitlab.example.test:8443@evil.example/GitLab/g/p/-/issues/7",
    ])
      expect(() => gitLabRoundTripConfig(config, url), url).toThrow();
    expect(() => gitLabRoundTripConfig(config)).toThrow("saved issue URL");
  });

  it("GitLab group mappings list the group's labels", async () => {
    vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "gitlab.example.test");
    const transport = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify([{ name: "workflow::doing" }])));
    setGitLabTransport(transport);
    expect(
      await gitlabRoundTrip.statuses({
        token: "t",
        host: "gitlab.example.test",
        groupPath: "g/sub",
      }),
    ).toMatchObject({
      scope: "group",
      statuses: expect.arrayContaining([{ name: "workflow::doing", category: "Label" }]),
    });
    expect(transport.mock.calls[0][0]).toBe(
      "https://gitlab.example.test/api/v4/groups/g%2Fsub/labels?per_page=100&page=1",
    );
  });

  it("Notion reaches new comments past the fifth page and keeps its version and auth headers", async () => {
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      const q = new URL(url).searchParams;
      const page = Number(q.get("start_cursor") ?? 0);
      expect(new URL(url).origin).toBe("https://api.notion.com");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer notion-token",
        "Notion-Version": "2022-06-28",
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              {
                id: `c${page}`,
                created_time: `2026-10-${10 + page}T00:00:00Z`,
                created_by: { id: "person" },
                rich_text: [{ plain_text: `page ${page}` }],
              },
            ],
            has_more: page < 5,
            next_cursor: page < 5 ? String(page + 1) : null,
          }),
        ),
      );
    });
    vi.stubGlobal("fetch", fetchSpy);
    const comments = await notionRoundTrip.listComments(
      "12345678-1234-1234-1234-123456789abc",
      { apiKey: "notion-token", databaseId: "db" },
      1,
    );
    expect(comments.map((c) => c.id)).toEqual(["c5"]);
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });

  it("Notion stops if pagination repeats a cursor", async () => {
    const fetchSpy = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ results: [], has_more: true, next_cursor: "same" })),
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      notionRoundTrip.listComments("12345678-1234-1234-1234-123456789abc", {
        apiKey: "token",
        databaseId: "db",
      }),
    ).rejects.toThrow("repeated a comments cursor");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("GitHub keeps identity failures closed when the credential is not an installation token", async () => {
    const fetchSpy = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 })),
      );
    vi.stubGlobal("fetch", fetchSpy);
    await expect(githubRoundTrip.whoAmI({ token: "bad", owner: "a", repo: "p" })).rejects.toThrow(
      "403",
    );
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/user",
      "https://api.github.com/installation/repositories?per_page=1",
    ]);
  });

  it.each([
    [githubRoundTrip, { token: "gh", owner: "a", repo: "p" }, "https://api.github.com/user"],
    [
      gitlabRoundTrip,
      { token: "gl", host: "gitlab.example.test", projectPath: "a/p" },
      "https://gitlab.example.test/api/v4/user",
    ],
    [linearRoundTrip, { apiKey: "lin" }, "https://api.linear.app/graphql"],
    [notionRoundTrip, { apiKey: "notion", databaseId: "db" }, "https://api.notion.com/v1/users/me"],
  ] as const)(
    "%s refuses redirects before any credential can reach another host",
    async (rt, config, endpoint) => {
      vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "gitlab.example.test");
      const target = await startFakeHttp(
        (_call, reply) => reply(200, {}),
        () => true,
      );
      const redirect = await startFakeHttp(
        (_call, reply) => reply(307, {}, { location: target.url }),
        () => true,
      );
      const realFetch = globalThis.fetch;
      const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
        expect(url).toBe(endpoint);
        return realFetch(redirect.url, init);
      });
      vi.stubGlobal("fetch", fetchSpy);
      try {
        await expect(rt.whoAmI(config)).rejects.toThrow("could not be reached");
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(target.calls).toHaveLength(0);
      } finally {
        await Promise.all([target.close(), redirect.close()]);
      }
    },
  );

  it("Linear checks attachment mutation success before deleting the previous link", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { issue: { id: "issue-uuid" } } })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { attachmentCreate: { success: false } } })),
      );
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      linearRoundTrip.upsertLink(
        "ENG-1",
        { globalId: "optio:1", url: "https://o.example/work/1", title: "run", previousId: "old" },
        { apiKey: "lin" },
      ),
    ).rejects.toThrow("didn't create the attachment");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const init = fetchSpy.mock.calls[1][1];
    expect(init.headers.Authorization).toBe("lin");
    expect(JSON.parse(init.body).variables.input).toMatchObject({ issueId: "issue-uuid" });
  });

  it.each([
    [{ errors: [{ message: "Permission denied" }] }, "Permission denied"],
    [{ data: { attachmentDelete: { success: false } } }, "didn't remove"],
  ])("Linear preserves failed attachment deletion for retry: %s", async (result, message) => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { issue: { id: "issue-uuid" } } })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { attachmentCreate: { success: true, attachment: { id: "new" } } },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(result)));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      linearRoundTrip.upsertLink(
        "ENG-1",
        { globalId: "optio:1", url: "https://o.example/work/1", title: "run", previousId: "old" },
        { apiKey: "lin" },
      ),
    ).rejects.toThrow(message);
  });
});
