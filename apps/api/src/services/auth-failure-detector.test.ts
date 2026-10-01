import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db client before importing the module under test so the import
// picks up the mocked chain instead of trying to connect to a real Postgres.
// Supports both .where().limit() and .where().orderBy().limit() call shapes.
const limitMock = vi.fn();
const orderByMock = vi.fn(() => ({ limit: limitMock }));
const whereMock = vi.fn(() => ({ limit: limitMock, orderBy: orderByMock }));
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));
const selectDistinctMock = vi.fn(() => ({ from: fromMock }));
const deleteMock = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../db/client.js", () => ({
  db: {
    select: selectMock,
    selectDistinct: selectDistinctMock,
    insert: vi.fn(() => ({ values: vi.fn() })),
    delete: deleteMock,
  },
}));

vi.mock("../db/schema.js", () => ({
  taskLogs: {
    taskId: "task_logs.task_id",
    persistentAgentTurnId: "task_logs.persistent_agent_turn_id",
    content: "task_logs.content",
    timestamp: "task_logs.timestamp",
  },
  workRuns: {
    id: "tasks.id",
    kind: "tasks.kind",
  },
  secrets: {
    name: "secrets.name",
    updatedAt: "secrets.updated_at",
  },
  authEvents: {
    tokenType: "auth_events.token_type",
    source: "auth_events.source",
    createdAt: "auth_events.created_at",
  },
}));

// Import after mocks are in place.
const {
  hasRecentClaudeAuthFailure,
  getRecentAuthFailures,
  recordAuthEvent,
  detectAuthFailureInLogs,
  AUTH_FAILURE_PATTERNS,
  GITHUB_FAILURE_PATTERNS,
} = await import("./auth-failure-detector.js");

// The execution order for getRecentAuthFailures is:
// 1. Claude watermark   (Promise.all group 1)
// 2. GitHub watermark   (Promise.all group 1)
// 3. Claude task_logs   (Promise.all group 2)
// 4. Claude auth_events (Promise.all group 2)
// 5. GitHub auth_events (Promise.all group 2)
// 6. GitHub task_logs   (Promise.all group 2)
//
// For hasRecentClaudeAuthFailure (backward compat), it calls getRecentAuthFailures
// which follows the same pattern but we only care about the claude result.

describe("hasRecentClaudeAuthFailure (backward compat)", () => {
  beforeEach(() => {
    selectMock.mockClear();
    fromMock.mockClear();
    whereMock.mockClear();
    limitMock.mockClear();
  });

  it("returns false when no recent auth-failure log lines are found", async () => {
    // 1. Claude watermark
    limitMock.mockResolvedValueOnce([]);
    // 2. GitHub watermark
    limitMock.mockResolvedValueOnce([]);
    // 3. Claude task_logs
    limitMock.mockResolvedValueOnce([]);
    // 4. Claude auth_events
    limitMock.mockResolvedValueOnce([]);
    // 5. GitHub auth_events
    limitMock.mockResolvedValueOnce([]);
    // 6. GitHub task_logs
    limitMock.mockResolvedValueOnce([]);
    await expect(hasRecentClaudeAuthFailure()).resolves.toBe(false);
  });

  it("returns true when at least one matching log row exists", async () => {
    // 1. Claude watermark
    limitMock.mockResolvedValueOnce([]);
    // 2. GitHub watermark
    limitMock.mockResolvedValueOnce([]);
    // 3. Claude task_logs — match!
    limitMock.mockResolvedValueOnce([{ exists: 1 }]);
    // 4. Claude auth_events
    limitMock.mockResolvedValueOnce([]);
    // 5. GitHub auth_events
    limitMock.mockResolvedValueOnce([]);
    // 6. GitHub task_logs
    limitMock.mockResolvedValueOnce([]);
    await expect(hasRecentClaudeAuthFailure()).resolves.toBe(true);
  });

  it("returns true when only an auth_events claude row exists (Standalone Task path)", async () => {
    // 1. Claude watermark
    limitMock.mockResolvedValueOnce([]);
    // 2. GitHub watermark
    limitMock.mockResolvedValueOnce([]);
    // 3. Claude task_logs — no match (a Job run's lines are not counted here)
    limitMock.mockResolvedValueOnce([]);
    // 4. Claude auth_events — match! (recorded by workflow-worker)
    limitMock.mockResolvedValueOnce([{ exists: 1 }]);
    // 5. GitHub auth_events
    limitMock.mockResolvedValueOnce([]);
    // 6. GitHub task_logs
    limitMock.mockResolvedValueOnce([]);
    await expect(hasRecentClaudeAuthFailure()).resolves.toBe(true);
  });
});

describe("getRecentAuthFailures", () => {
  beforeEach(() => {
    selectMock.mockClear();
    fromMock.mockClear();
    whereMock.mockClear();
    limitMock.mockClear();
  });

  it("returns both false when no failures detected", async () => {
    // 1. Claude watermark
    limitMock.mockResolvedValueOnce([]);
    // 2. GitHub watermark
    limitMock.mockResolvedValueOnce([]);
    // 3. Claude task_logs
    limitMock.mockResolvedValueOnce([]);
    // 4. Claude auth_events
    limitMock.mockResolvedValueOnce([]);
    // 5. GitHub auth_events
    limitMock.mockResolvedValueOnce([]);
    // 6. GitHub task_logs
    limitMock.mockResolvedValueOnce([]);

    const result = await getRecentAuthFailures();
    expect(result).toEqual({ claude: false, github: false });
  });

  it("returns claude=true when Claude auth failures found in task logs", async () => {
    // 1. Claude watermark
    limitMock.mockResolvedValueOnce([]);
    // 2. GitHub watermark
    limitMock.mockResolvedValueOnce([]);
    // 3. Claude task_logs — match!
    limitMock.mockResolvedValueOnce([{ exists: 1 }]);
    // 4. Claude auth_events
    limitMock.mockResolvedValueOnce([]);
    // 5. GitHub auth_events
    limitMock.mockResolvedValueOnce([]);
    // 6. GitHub task_logs
    limitMock.mockResolvedValueOnce([]);

    const result = await getRecentAuthFailures();
    expect(result).toEqual({ claude: true, github: false });
  });

  it("returns claude=true when Claude auth failures found in auth_events (Standalone)", async () => {
    // 1. Claude watermark
    limitMock.mockResolvedValueOnce([]);
    // 2. GitHub watermark
    limitMock.mockResolvedValueOnce([]);
    // 3. Claude task_logs
    limitMock.mockResolvedValueOnce([]);
    // 4. Claude auth_events — match! (recorded by workflow-worker)
    limitMock.mockResolvedValueOnce([{ exists: 1 }]);
    // 5. GitHub auth_events
    limitMock.mockResolvedValueOnce([]);
    // 6. GitHub task_logs
    limitMock.mockResolvedValueOnce([]);

    const result = await getRecentAuthFailures();
    expect(result).toEqual({ claude: true, github: false });
  });

  it("returns github=true when GitHub auth failures found in auth_events", async () => {
    // 1. Claude watermark
    limitMock.mockResolvedValueOnce([]);
    // 2. GitHub watermark
    limitMock.mockResolvedValueOnce([]);
    // 3. Claude task_logs
    limitMock.mockResolvedValueOnce([]);
    // 4. Claude auth_events
    limitMock.mockResolvedValueOnce([]);
    // 5. GitHub auth_events — match!
    limitMock.mockResolvedValueOnce([{ exists: 1 }]);
    // 6. GitHub task_logs
    limitMock.mockResolvedValueOnce([]);

    const result = await getRecentAuthFailures();
    expect(result).toEqual({ claude: false, github: true });
  });

  it("returns both true when both token types have failures", async () => {
    // 1. Claude watermark
    limitMock.mockResolvedValueOnce([]);
    // 2. GitHub watermark
    limitMock.mockResolvedValueOnce([]);
    // 3. Claude task_logs — match!
    limitMock.mockResolvedValueOnce([{ exists: 1 }]);
    // 4. Claude auth_events
    limitMock.mockResolvedValueOnce([]);
    // 5. GitHub auth_events — match!
    limitMock.mockResolvedValueOnce([{ exists: 1 }]);
    // 6. GitHub task_logs
    limitMock.mockResolvedValueOnce([]);

    const result = await getRecentAuthFailures();
    expect(result).toEqual({ claude: true, github: true });
  });

  it("uses watermark from secrets.updatedAt when token was recently updated", async () => {
    // 1. Claude watermark: token updated 2 minutes ago
    const recentUpdate = new Date(Date.now() - 2 * 60 * 1000);
    limitMock.mockResolvedValueOnce([{ updatedAt: recentUpdate }]);
    // 2. GitHub watermark
    limitMock.mockResolvedValueOnce([]);
    // 3. Claude task_logs: no failures in the narrowed window
    limitMock.mockResolvedValueOnce([]);
    // 4. Claude auth_events
    limitMock.mockResolvedValueOnce([]);
    // 5. GitHub auth_events
    limitMock.mockResolvedValueOnce([]);
    // 6. GitHub task_logs
    limitMock.mockResolvedValueOnce([]);

    const result = await getRecentAuthFailures();
    expect(result).toEqual({ claude: false, github: false });
    // The watermark query was made
    expect(selectMock).toHaveBeenCalled();
  });

  it("watermark narrows the window so old failures are ignored", async () => {
    // 1. Claude watermark: token updated 1 minute ago
    const recentUpdate = new Date(Date.now() - 60 * 1000);
    limitMock.mockResolvedValueOnce([{ updatedAt: recentUpdate }]);
    // 2. GitHub watermark: token updated 30 seconds ago
    const githubUpdate = new Date(Date.now() - 30 * 1000);
    limitMock.mockResolvedValueOnce([{ updatedAt: githubUpdate }]);
    // 3. Claude task_logs: no failures in the 1-minute window
    limitMock.mockResolvedValueOnce([]);
    // 4. Claude auth_events: no failures in the 1-minute window
    limitMock.mockResolvedValueOnce([]);
    // 5. GitHub auth_events: no failures in the 30-second window
    limitMock.mockResolvedValueOnce([]);
    // 6. GitHub task_logs: no failures
    limitMock.mockResolvedValueOnce([]);

    const result = await getRecentAuthFailures();
    expect(result).toEqual({ claude: false, github: false });
  });
});

describe("source-based filtering", () => {
  beforeEach(() => {
    selectMock.mockClear();
    fromMock.mockClear();
    whereMock.mockClear();
    limitMock.mockClear();
    deleteMock.mockClear();
  });

  it("returns github=false when only ticket-sync events exist (provider-specific failures)", async () => {
    // 1. Claude watermark
    limitMock.mockResolvedValueOnce([]);
    // 2. GitHub watermark
    limitMock.mockResolvedValueOnce([]);
    // 3. Claude task_logs
    limitMock.mockResolvedValueOnce([]);
    // 4. Claude auth_events
    limitMock.mockResolvedValueOnce([]);
    // 5. GitHub auth_events — filtered by source, no match after excluding ticket-sync:*
    limitMock.mockResolvedValueOnce([]);
    // 6. GitHub task_logs
    limitMock.mockResolvedValueOnce([]);

    const result = await getRecentAuthFailures();
    expect(result).toEqual({ claude: false, github: false });
  });

  it("returns github=true when pr-watcher events exist", async () => {
    // 1. Claude watermark
    limitMock.mockResolvedValueOnce([]);
    // 2. GitHub watermark
    limitMock.mockResolvedValueOnce([]);
    // 3. Claude task_logs
    limitMock.mockResolvedValueOnce([]);
    // 4. Claude auth_events
    limitMock.mockResolvedValueOnce([]);
    // 5. GitHub auth_events — pr-watcher source, should count
    limitMock.mockResolvedValueOnce([{ exists: 1 }]);
    // 6. GitHub task_logs
    limitMock.mockResolvedValueOnce([]);

    const result = await getRecentAuthFailures();
    expect(result).toEqual({ claude: false, github: true });
  });

  it("returns github=true when legacy null-source events exist", async () => {
    // 1. Claude watermark
    limitMock.mockResolvedValueOnce([]);
    // 2. GitHub watermark
    limitMock.mockResolvedValueOnce([]);
    // 3. Claude task_logs
    limitMock.mockResolvedValueOnce([]);
    // 4. Claude auth_events
    limitMock.mockResolvedValueOnce([]);
    // 5. GitHub auth_events — null source (legacy), should count
    limitMock.mockResolvedValueOnce([{ exists: 1 }]);
    // 6. GitHub task_logs
    limitMock.mockResolvedValueOnce([]);

    const result = await getRecentAuthFailures();
    expect(result).toEqual({ claude: false, github: true });
  });
});

describe("recordAuthEvent", () => {
  it("accepts an optional source parameter", async () => {
    // Should not throw
    await recordAuthEvent("github", "Bad credentials", "pr-watcher");
    await recordAuthEvent("github", "Bad credentials", "ticket-sync:abc-123");
    await recordAuthEvent("github", "Bad credentials");
  });
});

describe("failure pattern constants", () => {
  it("exposes the canonical set of Claude auth-failure substrings", () => {
    expect(AUTH_FAILURE_PATTERNS).toEqual(
      expect.arrayContaining([
        "api error: 401",
        "authentication_error",
        '"status":401',
        "invalid_api_key",
        "invalid api key",
        "oauth token has expired",
      ]),
    );
  });

  it("exposes GitHub-specific auth-failure substrings", () => {
    expect(GITHUB_FAILURE_PATTERNS).toEqual(
      expect.arrayContaining(["Bad credentials", "bad credentials"]),
    );
  });
});

describe("detectAuthFailureInLogs", () => {
  it("returns no match for empty input", () => {
    expect(detectAuthFailureInLogs("").matched).toBe(false);
  });

  it("returns no match for clean logs", () => {
    const logs = "Session started. Did some work. Wrote a file. Exiting cleanly.";
    expect(detectAuthFailureInLogs(logs).matched).toBe(false);
  });

  it("matches the claude stream-json 401 shape", () => {
    const logs =
      "Session started · claude-sonnet-4-6\n" +
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_abc"}\n' +
      "Session ended";
    const result = detectAuthFailureInLogs(logs);
    expect(result.matched).toBe(true);
    // "api error: 401" is listed before "authentication_error" in the pattern
    // array, so the first-match precedence means we should see that pattern.
    expect(result.pattern).toBe("api error: 401");
    expect(result.excerpt).toContain("authentication_error");
  });

  it("matches the plain authentication_error token", () => {
    const logs = 'irrelevant noise ... "type":"authentication_error" ... more noise';
    const result = detectAuthFailureInLogs(logs);
    expect(result.matched).toBe(true);
    expect(result.pattern).toBe("authentication_error");
  });

  it("matches case-insensitively", () => {
    const logs = "Error: API Error: 401 Unauthorized";
    const result = detectAuthFailureInLogs(logs);
    expect(result.matched).toBe(true);
    expect(result.pattern).toBe("api error: 401");
  });

  it('matches "status":401 embedded in JSON', () => {
    const logs = 'response body: {"status":401,"message":"bad token"}';
    expect(detectAuthFailureInLogs(logs).matched).toBe(true);
  });

  it("matches invalid_api_key from api-key mode", () => {
    const logs = "error: invalid_api_key provided";
    const result = detectAuthFailureInLogs(logs);
    expect(result.matched).toBe(true);
    expect(result.pattern).toBe("invalid_api_key");
  });

  it("matches oauth token has expired", () => {
    const logs = "[optio] precheck: OAuth token has expired — please re-run claude setup-token";
    const result = detectAuthFailureInLogs(logs);
    expect(result.matched).toBe(true);
    expect(result.pattern).toBe("oauth token has expired");
  });

  it("does not match unrelated '401' numbers", () => {
    const logs = "Processed 401 items successfully.";
    expect(detectAuthFailureInLogs(logs).matched).toBe(false);
  });

  it("excerpt is whitespace-normalized and capped", () => {
    const logs = "x".repeat(1000) + "\n\n   authentication_error   \t  " + "y".repeat(1000);
    const result = detectAuthFailureInLogs(logs);
    expect(result.matched).toBe(true);
    expect(result.excerpt).toBeDefined();
    expect(result.excerpt!.length).toBeLessThanOrEqual(240);
    expect(result.excerpt).not.toMatch(/\s{2,}/);
  });

  it("first matching pattern wins when several are present", () => {
    const logs = "invalid_api_key ... authentication_error ... api error: 401";
    // Array order determines precedence: "api error: 401" comes before the
    // other two in AUTH_FAILURE_PATTERNS.
    const result = detectAuthFailureInLogs(logs);
    expect(result.pattern).toBe("api error: 401");
  });

  it("ignores Read tool_result content even when it contains pattern text", () => {
    // Agent reads a test fixture that asserts on an Invalid API key response.
    // The string appears inside a `{"type":"user","message":{"content":[{"type":"tool_result",...}]}}`
    // NDJSON event, which is agent-internal data — not a real auth failure.
    const logs = [
      '{"type":"system","subtype":"init","model":"claude-sonnet-4-6"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"adapter.test.ts"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"209\\u2192 \'{\\"error\\":{\\"message\\":\\"Invalid API key\\",\\"type\\":\\"auth_error\\",\\"code\\":\\"invalid_key\\"}}\';\\n 210\\u2192 const result = adapter.parseResult(0, logs);"}]}}',
      '{"type":"result","result":"done","is_error":false}',
    ].join("\n");
    expect(detectAuthFailureInLogs(logs).matched).toBe(false);
  });

  it("ignores assistant tool_use input that contains pattern text", () => {
    // Agent is writing a fixture file via Edit — its tool_use input legitimately
    // contains the pattern. Should not trigger.
    const logs = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"x.ts","new_string":"const fixture = \'invalid_api_key\';"}}]}}',
      '{"type":"result","result":"done","is_error":false}',
    ].join("\n");
    expect(detectAuthFailureInLogs(logs).matched).toBe(false);
  });

  it("still matches a real auth failure that appears as runtime plain text", () => {
    // The agent runtime catches a 401 from Anthropic and prints it as plain
    // stdout/stderr — NOT as a stream-json event. This is the path we *do*
    // want to detect; the user/assistant filter must not suppress it.
    const logs = [
      '{"type":"system","subtype":"init","model":"claude-sonnet-4-6"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"x"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"file contents"}]}}',
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
    ].join("\n");
    const result = detectAuthFailureInLogs(logs);
    expect(result.matched).toBe(true);
    expect(result.pattern).toBe("api error: 401");
  });
});
