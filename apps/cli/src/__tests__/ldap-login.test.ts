import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";

const saved = vi.hoisted(() => ({
  config: { currentHost: undefined as string | undefined, hosts: {} as Record<string, unknown> },
  creds: { hosts: {} as Record<string, unknown> },
}));

vi.mock("../config/config-store.js", () => ({
  loadConfig: () => saved.config,
  saveConfig: (c: typeof saved.config) => {
    saved.config = c;
  },
}));
vi.mock("../config/credentials-store.js", () => ({
  loadCredentials: () => saved.creds,
  saveCredentials: (c: typeof saved.creds) => {
    saved.creds = c;
  },
}));

const answers = vi.hoisted(() => ({ list: [] as string[], asked: [] as string[] }));
vi.mock("../utils/prompt.js", () => ({
  createPrompter: () => ({
    ask: async (question: string, opts?: { hidden?: boolean }) => {
      answers.asked.push(`${question}${opts?.hidden ? " (hidden)" : ""}`);
      return answers.list.shift() ?? "";
    },
    close: () => {},
  }),
}));

import { performLogin } from "../auth/login.js";
import { performLdapLogin } from "../auth/ldap-login.js";

const SERVER = "https://optio.example.com";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("optio login --provider ldap", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    saved.config = { currentHost: undefined, hosts: {} };
    saved.creds = { hosts: {} };
    answers.list = [];
    answers.asked = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("asks for the username and a hidden password, posts them with cli: true, and keeps the token", async () => {
    answers.list = [" alice ", "s3cret"];
    fetchMock.mockResolvedValueOnce(
      json({
        token: "optio_pat_abc",
        tokenId: "key-1",
        user: { id: "u-1", email: null, displayName: "Alice" },
      }),
    );

    const result = await performLogin(SERVER, "ldap");

    expect(answers.asked).toEqual(["Username: ", "Password:  (hidden)"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SERVER}/api/auth/ldap/login`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      username: "alice",
      password: "s3cret",
      cli: true,
    });
    expect(result).toMatchObject({
      token: "optio_pat_abc",
      host: "optio.example.com",
      user: { id: "u-1", email: "", displayName: "Alice" },
    });
    expect(saved.config.currentHost).toBe("optio.example.com");
    expect(saved.config.hosts["optio.example.com"]).toEqual({ server: SERVER });
    expect(saved.creds.hosts["optio.example.com"]).toEqual({
      token: "optio_pat_abc",
      tokenId: "key-1",
      user: { id: "u-1", email: "", displayName: "Alice" },
    });
  });

  it("picks LDAP by itself when it is the only provider, with the provider's username label", async () => {
    answers.list = ["alice", "s3cret"];
    fetchMock
      .mockResolvedValueOnce(
        json({
          providers: [
            { name: "ldap", displayName: "Corp AD", method: "password", usernameLabel: "AD user" },
          ],
          authDisabled: false,
          profile: "standard",
        }),
      )
      .mockResolvedValueOnce(
        json({ token: "optio_pat_abc", tokenId: "key-1", user: { id: "u-1", email: "a@corp" } }),
      );

    const result = await performLogin(`${SERVER}/`);

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      `${SERVER}/api/auth/providers`,
      `${SERVER}/api/auth/ldap/login`,
    ]);
    expect(answers.asked[0]).toBe("AD user: ");
    expect(result.user.email).toBe("a@corp");
  });

  it("says why the server refused and stores nothing", async () => {
    answers.list = ["alice", "wrong"];
    fetchMock.mockResolvedValueOnce(json({ error: "Wrong username or password" }, 401));

    await expect(performLdapLogin(SERVER)).rejects.toThrow(
      "Sign-in failed: Wrong username or password",
    );
    expect(saved.creds.hosts).toEqual({});
  });

  it("refuses an empty password without calling the server", async () => {
    answers.list = ["alice", ""];
    await expect(performLdapLogin(SERVER)).rejects.toThrow("Give a password");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createPrompter", () => {
  it("answers each question from piped lines, in order", async () => {
    const { createPrompter } =
      await vi.importActual<typeof import("../utils/prompt.js")>("../utils/prompt.js");
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.on("data", (c) => (shown += String(c)));
    const prompter = createPrompter({ input, output });
    input.end("alice\ns3cret\n");
    expect(await prompter.ask("Username: ")).toBe("alice");
    expect(await prompter.ask("Password: ", { hidden: true })).toBe("s3cret");
    prompter.close();
    expect(shown).toBe("Username: Password: \n");
  });
});
