/**
 * Integration tests for refreshing CLAUDE_CODE_OAUTH_TOKEN from a paired
 * machine (local-auth-refresh-service.ts) against real Postgres + Redis. A
 * fake daemon socket on the relay plays the machine: the service's
 * `credentials` request goes out, the test answers with a
 * `credentials-result`, and the token lands in the secrets store with the
 * validation cache marked good. Anthropic is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../workers/token-validation-worker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workers/token-validation-worker.js")>();
  return { ...actual, validateClaudeToken: vi.fn() };
});

import * as relay from "./local-relay.js";
import { registerHost } from "./local-host-service.js";
import { retrieveSecret } from "./secret-service.js";
import {
  getCachedTokenValidation,
  recordTokenValidation,
  validateClaudeToken,
} from "../workers/token-validation-worker.js";
import {
  autoRefreshClaudeToken,
  deliverCredentialsResult,
  hostMayRefreshToken,
  maybeRefreshOnHello,
  refreshClaudeTokenFromHost,
  resetAuthRefreshForTests,
} from "./local-auth-refresh-service.js";

const GOOD_TOKEN = "sk-ant-oat01-" + "a".repeat(40);

/** A daemon that answers every `credentials` request with `answer`. */
class FakeDaemon implements relay.RelaySocket {
  readyState = 1;
  sent: Array<Record<string, any>> = [];
  constructor(
    private readonly hostId: string,
    private answer: (requestId: string) => Record<string, unknown> | null,
  ) {}
  send(data: string | Buffer) {
    const msg = JSON.parse(String(data));
    this.sent.push(msg);
    if (msg.type === "credentials") {
      const reply = this.answer(msg.requestId);
      if (reply) {
        setTimeout(() => {
          deliverCredentialsResult(this.hostId, {
            type: "credentials-result",
            requestId: msg.requestId,
            ...reply,
          } as any);
        }, 0);
      }
    }
  }
  close() {
    this.readyState = 3;
  }
}

async function makeHost(claudeCredentials: boolean, answer: FakeDaemon["answer"]) {
  const host = await registerHost({
    userId: null,
    workspaceId: null,
    hostname: `it-auth-${Math.random().toString(36).slice(2, 8)}`,
    platform: "darwin",
    arch: "arm64",
    daemonVersion: "0.1.0",
    dirs: [{ path: "/home/dev/scratch" }],
  });
  const daemon = new FakeDaemon(host.id, answer);
  relay.registerDaemon(host.id, null, daemon, { claudeCredentials });
  return { host, daemon };
}

const mockedValidate = vi.mocked(validateClaudeToken);

beforeEach(() => {
  process.env.OPTIO_AUTH_DISABLED = "true";
  relay.resetRelayForTests();
  resetAuthRefreshForTests();
  mockedValidate.mockReset();
  mockedValidate.mockResolvedValue({ valid: true });
});
afterEach(() => {
  delete process.env.OPTIO_AUTH_DISABLED;
  relay.resetRelayForTests();
  resetAuthRefreshForTests();
});

describe("refreshClaudeTokenFromHost", () => {
  it("stores the machine's token after validating it and marks the cache good", async () => {
    await recordTokenValidation({ valid: false, tokenExists: true, error: "expired" });
    const { host, daemon } = await makeHost(true, () => ({ token: GOOD_TOKEN }));

    const outcome = await refreshClaudeTokenFromHost(host, "manual");
    expect(outcome).toEqual({ ok: true, hostId: host.id });
    expect(daemon.sent.map((m) => m.type)).toEqual(["credentials"]);
    expect(mockedValidate).toHaveBeenCalledWith(GOOD_TOKEN);
    expect(await retrieveSecret("CLAUDE_CODE_OAUTH_TOKEN")).toBe(GOOD_TOKEN);
    expect(await getCachedTokenValidation()).toMatchObject({ valid: true, tokenExists: true });
  });

  it("reports an offline host, a host without a login, and a machine whose token is stale too", async () => {
    const offline = await registerHost({
      userId: null,
      workspaceId: null,
      hostname: "it-auth-offline",
      platform: "darwin",
      arch: "arm64",
      daemonVersion: "0.1.0",
      dirs: [],
    });
    expect(await refreshClaudeTokenFromHost(offline, "manual")).toMatchObject({
      ok: false,
      error: expect.stringContaining("offline"),
    });

    const { host: noLogin } = await makeHost(false, () => null);
    expect(await refreshClaudeTokenFromHost(noLogin, "manual")).toMatchObject({
      ok: false,
      error: expect.stringContaining("no Claude Code login"),
    });

    mockedValidate.mockResolvedValue({ valid: false, error: "expired" });
    const { host: stale } = await makeHost(true, () => ({ token: GOOD_TOKEN }));
    expect(await refreshClaudeTokenFromHost(stale, "manual")).toMatchObject({
      ok: false,
      error: expect.stringContaining("expired too"),
    });
  });

  it("rejects a daemon error, a non-token, and an answer from the wrong host", async () => {
    const { host: errHost } = await makeHost(true, () => ({ error: "not logged in" }));
    expect(await refreshClaudeTokenFromHost(errHost, "manual")).toEqual({
      ok: false,
      error: "not logged in",
    });

    const { host: junkHost } = await makeHost(true, () => ({ token: "hunter2" }));
    expect(await refreshClaudeTokenFromHost(junkHost, "manual")).toMatchObject({
      ok: false,
      error: expect.stringContaining("not a Claude OAuth token"),
    });

    expect(
      deliverCredentialsResult("00000000-0000-0000-0000-000000000000", {
        type: "credentials-result",
        requestId: "nope",
        token: GOOD_TOKEN,
      }),
    ).toBe(false);
  });
});

describe("automatic refresh", () => {
  it("only lets an admin's host (or auth-disabled dev) seed the token", async () => {
    const { host } = await makeHost(true, () => ({ token: GOOD_TOKEN }));
    expect(await hostMayRefreshToken(host)).toBe(true);
    delete process.env.OPTIO_AUTH_DISABLED;
    expect(await hostMayRefreshToken(host)).toBe(false);
  });

  it("refreshes from the first capable host and retries a host only after the window", async () => {
    const { host: silent, daemon: silentDaemon } = await makeHost(true, () => null);
    // Make the silent host time out fast by answering with an error instead.
    silentDaemon["answer"] = () => ({ error: "no login" });
    const { daemon: good } = await makeHost(true, () => ({ token: GOOD_TOKEN }));

    expect(await autoRefreshClaudeToken("test")).toBe(true);
    expect(await retrieveSecret("CLAUDE_CODE_OAUTH_TOKEN")).toBe(GOOD_TOKEN);
    expect(good.sent.filter((m) => m.type === "credentials")).toHaveLength(1);

    // Within the window neither host is asked again.
    expect(await autoRefreshClaudeToken("test")).toBe(false);
    expect(good.sent.filter((m) => m.type === "credentials")).toHaveLength(1);
    expect(silentDaemon.sent.filter((m) => m.type === "credentials")).toHaveLength(1);
    void silent;
  });

  it("refreshes on hello only while the stored token is known-bad", async () => {
    const { host, daemon } = await makeHost(true, () => ({ token: GOOD_TOKEN }));
    await recordTokenValidation({ valid: true, tokenExists: true });
    await maybeRefreshOnHello(host);
    expect(daemon.sent).toHaveLength(0);

    await recordTokenValidation({ valid: false, tokenExists: true, error: "expired" });
    await maybeRefreshOnHello(host);
    expect(daemon.sent.map((m) => m.type)).toEqual(["credentials"]);
    expect(await getCachedTokenValidation()).toMatchObject({ valid: true });
  });
});
