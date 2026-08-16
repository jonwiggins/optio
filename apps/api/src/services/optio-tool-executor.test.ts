import { describe, it, expect, vi } from "vitest";
import {
  executeToolCall,
  truncateToolResult,
  watchTask,
  MAX_TOOL_RESULT_LENGTH,
} from "./optio-tool-executor.js";

type InjectResponse = { statusCode: number; body: string };

/** Create a minimal Fastify-like app with a mocked inject method. */
function mockApp(response: InjectResponse) {
  return {
    inject: vi.fn().mockResolvedValue(response),
  } as unknown as Parameters<typeof executeToolCall>[0];
}

/**
 * Fastify-like app whose inject returns each queued response in order, then
 * repeats the final response for any further polls.
 */
function mockAppSeq(responses: InjectResponse[]) {
  const inject = vi.fn();
  for (const r of responses) inject.mockResolvedValueOnce(r);
  inject.mockResolvedValue(responses[responses.length - 1]);
  return { inject } as unknown as Parameters<typeof executeToolCall>[0];
}

/**
 * A deterministic clock for the watch poll loop: `sleep` advances the clock
 * instead of waiting, so timeouts are driven purely by poll intervals and the
 * loop never touches a real timer.
 */
function makeFakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

/** Build a `GET /api/tasks/:id` enriched response body for a given state. */
function taskDetailBody(state: string, id = "task-1"): string {
  return JSON.stringify({
    task: { type: "repo-task", id, state },
    pendingReason: null,
    pipelineProgress: null,
    stallInfo: null,
  });
}

const injectMock = (app: Parameters<typeof executeToolCall>[0]) =>
  (app as unknown as { inject: ReturnType<typeof vi.fn> }).inject;

describe("optio-tool-executor", () => {
  // ─── executeToolCall ───

  describe("executeToolCall", () => {
    it("executes a GET tool with no parameters", async () => {
      const app = mockApp({ statusCode: 200, body: '{"repos":[]}' });
      const result = await executeToolCall(app, "list_repos", {}, "token123");

      expect(result.success).toBe(true);
      expect(result.result).toBe('{"repos":[]}');
      expect(app.inject as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          url: "/api/repos",
          headers: expect.objectContaining({
            cookie: "optio_session=token123",
          }),
        }),
      );
    });

    it("replaces path parameters in the URL", async () => {
      const app = mockApp({ statusCode: 200, body: '{"id":"abc","title":"test"}' });
      const result = await executeToolCall(app, "get_task", { id: "abc-123" }, "tok");

      expect(result.success).toBe(true);
      expect(app.inject as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "/api/tasks/abc-123",
        }),
      );
    });

    it("adds remaining params as query string for GET", async () => {
      const app = mockApp({ statusCode: 200, body: "[]" });
      await executeToolCall(app, "list_tasks", { state: "failed", limit: 10 }, "tok");

      const call = (app.inject as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.url).toContain("state=failed");
      expect(call.url).toContain("limit=10");
      expect(call.method).toBe("GET");
    });

    it("sends remaining params as payload for POST", async () => {
      const app = mockApp({ statusCode: 201, body: '{"id":"new-task"}' });
      await executeToolCall(
        app,
        "create_task",
        { title: "Fix bug", repoUrl: "https://github.com/test/repo", prompt: "Fix it" },
        "tok",
      );

      const call = (app.inject as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.method).toBe("POST");
      expect(call.url).toBe("/api/tasks");
      expect(call.payload).toEqual({
        title: "Fix bug",
        repoUrl: "https://github.com/test/repo",
        prompt: "Fix it",
      });
    });

    it("separates path params from body params for POST with :id", async () => {
      const app = mockApp({ statusCode: 200, body: '{"ok":true}' });
      await executeToolCall(app, "retry_task", { id: "task-42" }, "tok");

      const call = (app.inject as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.method).toBe("POST");
      expect(call.url).toBe("/api/tasks/task-42/retry");
      // No payload since the only param was the path param
      expect(call.payload).toBeUndefined();
    });

    it("returns success=false for 4xx/5xx status codes", async () => {
      const app = mockApp({ statusCode: 404, body: '{"error":"Not found"}' });
      const result = await executeToolCall(app, "get_task", { id: "missing" }, "tok");

      expect(result.success).toBe(false);
      expect(result.result).toBe('{"error":"Not found"}');
    });

    it("returns success=false for unknown tool names", async () => {
      const app = mockApp({ statusCode: 200, body: "" });
      const result = await executeToolCall(app, "nonexistent_tool", {}, "tok");

      expect(result.success).toBe(false);
      expect(result.result).toContain("Unknown tool");
      // inject should not have been called
      expect(app.inject as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });

    it("returns success=false when inject throws", async () => {
      const app = {
        inject: vi.fn().mockRejectedValue(new Error("Connection refused")),
      } as unknown as Parameters<typeof executeToolCall>[0];

      const result = await executeToolCall(app, "list_tasks", {}, "tok");

      expect(result.success).toBe(false);
      expect(result.result).toContain("Connection refused");
    });

    it("encodes path parameter values", async () => {
      const app = mockApp({ statusCode: 200, body: "{}" });
      await executeToolCall(app, "get_task", { id: "id with spaces/special" }, "tok");

      const call = (app.inject as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.url).toContain("id%20with%20spaces%2Fspecial");
    });

    it("skips undefined values in remaining params", async () => {
      const app = mockApp({ statusCode: 200, body: "[]" });
      await executeToolCall(
        app,
        "list_tasks",
        { state: "failed", repoUrl: undefined, limit: 5 },
        "tok",
      );

      const call = (app.inject as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.url).toContain("state=failed");
      expect(call.url).toContain("limit=5");
      expect(call.url).not.toContain("repoUrl");
    });
  });

  // ─── watchTask (poll-until-terminal) ───

  describe("watchTask", () => {
    it("polls through non-terminal states and returns the terminal state", async () => {
      const app = mockAppSeq([
        { statusCode: 200, body: taskDetailBody("running") },
        { statusCode: 200, body: taskDetailBody("running") },
        { statusCode: 200, body: taskDetailBody("completed") },
      ]);
      const clock = makeFakeClock();

      const result = await watchTask(
        app,
        { id: "task-1", pollIntervalSeconds: 5, timeoutMinutes: 10 },
        "tok",
        clock,
      );

      // It waited: three polls, not one immediate snapshot.
      expect(injectMock(app)).toHaveBeenCalledTimes(3);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.result);
      expect(parsed.watch).toBe("terminal");
      expect(parsed.state).toBe("completed");
      expect(parsed.polls).toBe(3);
    });

    it("returns immediately when the task is already terminal", async () => {
      const app = mockAppSeq([{ statusCode: 200, body: taskDetailBody("failed") }]);
      const clock = makeFakeClock();

      const result = await watchTask(app, { id: "task-1" }, "tok", clock);

      expect(injectMock(app)).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(result.result);
      expect(parsed.watch).toBe("terminal");
      expect(parsed.state).toBe("failed");
    });

    it("does not treat a running snapshot as a successful final watch — it times out", async () => {
      const app = mockAppSeq([{ statusCode: 200, body: taskDetailBody("running") }]);
      const clock = makeFakeClock();

      const result = await watchTask(
        app,
        { id: "task-1", pollIntervalSeconds: 5, timeoutMinutes: 1 },
        "tok",
        clock,
      );

      const parsed = JSON.parse(result.result);
      expect(parsed.watch).toBe("timeout");
      expect(parsed.state).toBe("running");
      expect(parsed.message).toContain("still running");
      expect(parsed.timeoutMinutes).toBe(1);
      // It polled repeatedly across the minute rather than returning once.
      expect(injectMock(app).mock.calls.length).toBeGreaterThan(1);
      // A timeout is a completed watch operation, reported as a normal result.
      expect(result.success).toBe(true);
    });

    it("uses the requested poll interval between checks", async () => {
      const app = mockAppSeq([
        { statusCode: 200, body: taskDetailBody("running") },
        { statusCode: 200, body: taskDetailBody("completed") },
      ]);
      const sleep = vi.fn(async () => {});

      await watchTask(app, { id: "task-1", pollIntervalSeconds: 7, timeoutMinutes: 10 }, "tok", {
        sleep,
        now: () => 0,
      });

      expect(sleep).toHaveBeenCalledWith(7000);
    });

    it("clamps a sub-minimum poll interval up to the 2s floor", async () => {
      const app = mockAppSeq([
        { statusCode: 200, body: taskDetailBody("running") },
        { statusCode: 200, body: taskDetailBody("completed") },
      ]);
      const sleep = vi.fn(async () => {});

      await watchTask(
        app,
        { id: "task-1", pollIntervalSeconds: 0.001, timeoutMinutes: 10 },
        "tok",
        { sleep, now: () => 0 },
      );

      expect(sleep).toHaveBeenCalledWith(2000);
    });

    it("clamps an oversized poll interval down to the 60s ceiling", async () => {
      const app = mockAppSeq([
        { statusCode: 200, body: taskDetailBody("running") },
        { statusCode: 200, body: taskDetailBody("completed") },
      ]);
      const sleep = vi.fn(async () => {});

      await watchTask(app, { id: "task-1", pollIntervalSeconds: 9999, timeoutMinutes: 10 }, "tok", {
        sleep,
        now: () => 0,
      });

      expect(sleep).toHaveBeenCalledWith(60000);
    });

    it("surfaces a non-2xx lookup immediately without polling", async () => {
      const app = mockAppSeq([{ statusCode: 404, body: '{"error":"Task not found"}' }]);
      const clock = makeFakeClock();

      const result = await watchTask(app, { id: "missing" }, "tok", clock);

      expect(injectMock(app)).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.result).toContain("Task not found");
    });

    it("rejects a missing id without hitting the API", async () => {
      const app = mockAppSeq([{ statusCode: 200, body: taskDetailBody("running") }]);

      const result = await watchTask(app, {}, "tok", makeFakeClock());

      expect(result.success).toBe(false);
      expect(result.result).toContain("requires a string task id");
      expect(injectMock(app)).not.toHaveBeenCalled();
    });

    it("polls the enriched task detail endpoint with the session cookie", async () => {
      const app = mockAppSeq([{ statusCode: 200, body: taskDetailBody("completed") }]);

      await watchTask(app, { id: "task-1" }, "tok", makeFakeClock());

      const call = injectMock(app).mock.calls[0][0];
      expect(call.method).toBe("GET");
      expect(call.url).toBe("/api/tasks/task-1");
      expect(call.headers.cookie).toBe("optio_session=tok");
    });

    it("is reachable through executeToolCall dispatch", async () => {
      const app = mockAppSeq([{ statusCode: 200, body: taskDetailBody("completed") }]);

      const result = await executeToolCall(app, "watch_task", { id: "task-1" }, "tok");

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.result);
      expect(parsed.watch).toBe("terminal");
      expect(parsed.state).toBe("completed");
    });
  });

  // ─── truncateToolResult ───

  describe("truncateToolResult", () => {
    it("returns short strings unchanged", () => {
      expect(truncateToolResult("hello")).toBe("hello");
    });

    it("truncates strings exceeding MAX_TOOL_RESULT_LENGTH", () => {
      const long = "x".repeat(MAX_TOOL_RESULT_LENGTH + 100);
      const truncated = truncateToolResult(long);
      expect(truncated.length).toBeLessThan(long.length);
      expect(truncated).toContain("… (truncated)");
      expect(truncated.startsWith("x".repeat(100))).toBe(true);
    });

    it("does not truncate strings at exactly MAX_TOOL_RESULT_LENGTH", () => {
      const exact = "y".repeat(MAX_TOOL_RESULT_LENGTH);
      expect(truncateToolResult(exact)).toBe(exact);
    });
  });
});
