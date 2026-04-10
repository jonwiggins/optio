import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db client before importing the module under test so the import
// picks up the mocked chain instead of trying to connect to a real Postgres.
const limitMock = vi.fn();
const whereMock = vi.fn(() => ({ limit: limitMock }));
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock("../db/client.js", () => ({
  db: {
    select: selectMock,
    insert: vi.fn(() => ({ values: vi.fn() })),
  },
}));

vi.mock("../db/schema.js", () => ({
  taskLogs: {
    content: "task_logs.content",
    timestamp: "task_logs.timestamp",
  },
  secrets: {
    name: "secrets.name",
    updatedAt: "secrets.updated_at",
  },
  authEvents: {
    tokenType: "auth_events.token_type",
    createdAt: "auth_events.created_at",
  },
}));

// Import after mocks are in place.
const {
  hasRecentClaudeAuthFailure,
  getRecentAuthFailures,
  AUTH_FAILURE_PATTERNS,
  GITHUB_FAILURE_PATTERNS,
} = await import("./auth-failure-detector.js");

// The execution order for getRecentAuthFailures is:
// 1. Claude watermark  (Promise.all group 1)
// 2. GitHub watermark  (Promise.all group 1)
// 3. Claude task_logs  (Promise.all group 2)
// 4. GitHub auth_events (Promise.all group 2)
// 5. GitHub task_logs  (Promise.all group 2)
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
    // 4. GitHub auth_events
    limitMock.mockResolvedValueOnce([]);
    // 5. GitHub task_logs
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
    // 4. GitHub auth_events
    limitMock.mockResolvedValueOnce([]);
    // 5. GitHub task_logs
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
    // 4. GitHub auth_events
    limitMock.mockResolvedValueOnce([]);
    // 5. GitHub task_logs
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
    // 4. GitHub auth_events
    limitMock.mockResolvedValueOnce([]);
    // 5. GitHub task_logs
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
    // 4. GitHub auth_events — match!
    limitMock.mockResolvedValueOnce([{ exists: 1 }]);
    // 5. GitHub task_logs
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
    // 4. GitHub auth_events — match!
    limitMock.mockResolvedValueOnce([{ exists: 1 }]);
    // 5. GitHub task_logs
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
    // 4. GitHub auth_events
    limitMock.mockResolvedValueOnce([]);
    // 5. GitHub task_logs
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
    // 4. GitHub auth_events: no failures in the 30-second window
    limitMock.mockResolvedValueOnce([]);
    // 5. GitHub task_logs: no failures
    limitMock.mockResolvedValueOnce([]);

    const result = await getRecentAuthFailures();
    expect(result).toEqual({ claude: false, github: false });
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
